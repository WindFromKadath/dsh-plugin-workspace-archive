/**
 * 离线迁移引擎 · 写入层（**唯一会动文件的地方**）。
 *
 * ## 安全顺序（刻意如此）
 *
 *   ① 备份（**在任何改动之前**，整份会话目录 + manifest + plan）
 *   ② 逐条：改写第 0 帧 → 写到目标（**临时文件 + 原子 rename**）
 *   ③ 自检：目标文件的 header cwd 正确、第 0 帧之后的字节与源**逐字节相同**、事件行逐字相同
 *   ④ **最后才删源目录**
 *
 * ⇒ 任何一步失败，**源都还在**；最坏情况是目标多了一份（可用 `--rollback` 清掉）。
 * 刻意不用「先删后写」，也不用跨目录 `rename`（跨盘会失败，且失败时源已不在原位）。
 *
 * ## 为什么它不在插件里
 *
 * 它直写 `sessions/`，与插件赖以立身的两条（运行时只走官方 API + 零依赖）冲突。
 * 见 AGENTS.md 的危险操作边界与 [docs/plan-session-migration.md](../docs/plan-session-migration.md)。
 *
 * @module dsh-plugin-workspace-archive/offline/apply
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { firstFrameEnd, readAllText, readHeader, rewriteHeaderCwd } from './frames.js'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 尽力而为地看一眼 DSH 是否在跑。
 *
 * ⚠️ **不可信**：Windows 上没有 `lsof`/`pgrep`；这里用 `tasklist`，且任何失败都返回 `'unknown'`。
 * 生态先例（`dsh-mv-session` 的 `detectLiveDsh()`）就是**静默失效**——所以本工具的写入闸门
 * **不依赖它**，而是依赖调用方显式声明（`--i-have-stopped-dsh`）。
 * @returns `'running'` | `'not-found'` | `'unknown'`
 */
export function probeDshRunning() {
  return new Promise((resolve) => {
    try {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error !== null) return resolve('unknown')
        const text = String(stdout).toLowerCase()
        // Electron 应用进程名随打包方式而变，所以这里只认常见的几种，认不出就算 not-found。
        const hit = ['deepseek harness.exe', 'deepseek-harness.exe', 'dsh.exe'].some((name) => text.includes(name))
        resolve(hit ? 'running' : 'not-found')
      })
    } catch {
      resolve('unknown')
    }
  })
}

/**
 * 独立复核一次迁移结果。纯函数。
 * @param srcBuffer - 源文件字节。
 * @param dstBuffer - 目标文件字节。
 * @param expectedCwd - 目标 header 应有的 cwd。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
 */
export function verifyMigration(srcBuffer, dstBuffer, expectedCwd) {
  const header = readHeader(dstBuffer)
  if (header.ok !== true) return { ok: false, reason: `dst-header-unreadable: ${header.reason}` }
  if (header.header.cwd !== expectedCwd) return { ok: false, reason: `dst-cwd-mismatch (${header.header.cwd})` }

  const srcEnd = firstFrameEnd(srcBuffer)
  const dstEnd = firstFrameEnd(dstBuffer)
  if (srcEnd < 0 || dstEnd < 0) return { ok: false, reason: 'frame-0-unreadable' }
  if (dstBuffer.subarray(dstEnd).equals(srcBuffer.subarray(srcEnd)) === false) {
    return { ok: false, reason: 'bytes-after-frame-0-changed' }
  }

  const srcText = readAllText(srcBuffer)
  const dstText = readAllText(dstBuffer)
  if (srcText === undefined || dstText === undefined) return { ok: false, reason: 'event-stream-unreadable' }
  const srcLines = srcText.split('\n').filter((line) => line.length > 0)
  const dstLines = dstText.split('\n').filter((line) => line.length > 0)
  if (srcLines.length !== dstLines.length) return { ok: false, reason: 'line-count-changed' }
  for (let index = 1; index < srcLines.length; index++) {
    if (srcLines[index] !== dstLines[index]) return { ok: false, reason: `event-line-${index}-changed` }
  }
  return { ok: true }
}

/**
 * 执行一份计划。**会真正改动文件。**
 * @param plan - `buildPlan()` 的返回值，必须 `ok === true`。
 * @param options - `{ backupRoot, confirmed }`；`confirmed` 必须是字面量 `true`（显式闸门）。
 * @returns 结果对象。
 */
export async function applyPlan(plan, options) {
  if (options?.confirmed !== true) return { ok: false, reason: 'not-confirmed' }
  if (plan?.ok !== true) return { ok: false, reason: 'plan-not-usable', blockers: plan?.blockers ?? [] }
  const backupRoot = options?.backupRoot
  if (typeof backupRoot !== 'string' || backupRoot.length === 0) {
    return { ok: false, reason: 'backup-root-required' }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(backupRoot, stamp)
  await mkdir(backupDir, { recursive: true })

  // ① 备份（任何改动之前）
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    fromCwd: plan.fromCwd,
    toCwd: plan.toCwd,
    sessions: []
  }
  for (const session of plan.sessions) {
    const sessionBackup = join(backupDir, 'sessions', session.sessionId)
    await cp(session.srcDir, sessionBackup, { recursive: true })
    manifest.sessions.push({
      sessionId: session.sessionId,
      srcDir: session.srcDir,
      dstDir: session.dstDir,
      srcLog: session.srcLog,
      dstLog: session.dstLog,
      backupDir: sessionBackup
    })
  }
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(backupDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8')

  // ②③④ 逐条：改写 → 写新 → 自检 → 删源
  const migrated = []
  for (const session of plan.sessions) {
    const source = await readFile(session.srcLog)
    const rewritten = await rewriteHeaderCwd(source, plan.toCwd)
    if (rewritten.ok !== true) {
      return { ok: false, reason: 'rewrite-failed', sessionId: session.sessionId, detail: rewritten.reason, backupDir, migrated }
    }
    await mkdir(dirname(session.dstLog), { recursive: true })
    const temporary = `${session.dstLog}.tmp-${process.pid}`
    await writeFile(temporary, rewritten.buffer)
    await rename(temporary, session.dstLog)

    const written = await readFile(session.dstLog)
    const check = verifyMigration(source, written, plan.toCwd)
    if (check.ok !== true) {
      return { ok: false, reason: 'verify-failed', sessionId: session.sessionId, detail: check.reason, backupDir, migrated }
    }
    await rm(session.srcDir, { recursive: true, force: true })
    migrated.push(session.sessionId)
  }

  return { ok: true, backupDir, migrated: migrated.length, sessionIds: migrated }
}

/**
 * 用备份回滚。逐条把源目录放回去，并删掉目标目录。
 * @param backupDir - `applyPlan()` 建出来的那个备份目录。
 * @returns 结果对象。
 */
export async function rollback(backupDir) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    return { ok: false, reason: `manifest-unreadable: ${String(error)}` }
  }

  const restored = []
  for (const session of manifest.sessions) {
    if (await exists(session.srcDir)) {
      return { ok: false, reason: `source-already-exists (${session.sessionId})`, restored }
    }
    await mkdir(dirname(session.srcDir), { recursive: true })
    await cp(session.backupDir, session.srcDir, { recursive: true })
    await rm(session.dstDir, { recursive: true, force: true })
    restored.push(session.sessionId)
  }
  return { ok: true, restored: restored.length, sessionIds: restored }
}
