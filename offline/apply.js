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
import { setTimeout as sleep } from 'node:timers/promises'

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
 * 写一份**迁移意图**给在线层（插件启动后/下一轮对账时）消费。
 *
 * 离线层能做的是"改 cwd + 搬目录"；把会话挂到新工作区的成员表里只能由插件走官方
 * `attachSession` 做。归档态**不用写进意图** —— 官方归档集合是会话 id 的全局集合，
 * 与 cwd 无关，`attachSession` 也不看它。
 * @param intentPath - 意图文件路径。
 * @param payload - `{ fromCwd, toCwd, backupDir, sessionIds }`。
 */
export async function writeMigrationIntent(intentPath, payload) {
  await mkdir(dirname(intentPath), { recursive: true })
  await writeFile(intentPath, JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    fromCwd: payload.fromCwd,
    toCwd: payload.toCwd,
    backupDir: payload.backupDir ?? null,
    sessions: [...payload.sessionIds]
  }, null, 2), 'utf8')
}

/**
 * 执行一份计划。**会真正改动文件。**
 * @param plan - `buildPlan()` 的返回值，必须 `ok === true`。
 * @param options - `{ backupRoot, confirmed, intentPath }`；`confirmed` 必须是字面量 `true`（显式闸门）。
 * @returns 结果对象。
 */
export async function applyPlan(plan, options) {
  if (options?.confirmed !== true) return { ok: false, reason: 'not-confirmed' }
  if (plan?.ok !== true) return { ok: false, reason: 'plan-not-usable', blockers: plan?.blockers ?? [] }
  const backupRoot = options?.backupRoot
  if (typeof backupRoot !== 'string' || backupRoot.length === 0) {
    return { ok: false, reason: 'backup-root-required' }
  }
  const intentPath = typeof options?.intentPath === 'string' && options.intentPath.length > 0
    ? options.intentPath
    : null

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(backupRoot, stamp)
  await mkdir(backupDir, { recursive: true })

  // ① 备份（任何改动之前）
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    fromCwd: plan.fromCwd,
    toCwd: plan.toCwd,
    intentPath,
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

  // ②③④ 逐条：改写 → 写新 → 自检 → **把源改名成墓碑**（不是直接删）
  //
  // ⚠️ 为什么是"改名"而不是"删除"：实测（真机阶段 10）证明，若那条会话**正被打开**，
  // 写入方拿着指向旧路径的句柄继续写 —— 删掉目录之后它**写入仍然成功、也不报错**，而数据
  // 落到一个没有目录项的文件上，**静默丢失**。改名就不同：句柄跟着走到墓碑上，数据**留在
  // 墓碑里**，于是"还在被写"这件事变成**可探测**的（见 ⑤ 的静默窗口）。
  const migrated = []
  const tombstones = []
  for (const session of plan.sessions) {
    const source = await readFile(session.srcLog)
    const rewritten = await rewriteHeaderCwd(source, plan.toCwd)
    if (rewritten.ok !== true) {
      return { ok: false, reason: 'rewrite-failed', sessionId: session.sessionId, detail: rewritten.reason, backupDir, migrated: migrated.length, sessionIds: migrated }
    }
    await mkdir(dirname(session.dstLog), { recursive: true })
    const temporary = `${session.dstLog}.tmp-${process.pid}`
    await writeFile(temporary, rewritten.buffer)
    await rename(temporary, session.dstLog)

    const written = await readFile(session.dstLog)
    const check = verifyMigration(source, written, plan.toCwd)
    if (check.ok !== true) {
      return { ok: false, reason: 'verify-failed', sessionId: session.sessionId, detail: check.reason, backupDir, migrated: migrated.length, sessionIds: migrated }
    }
    const tombstone = `${session.srcDir}.migrating-${process.pid}`
    try {
      await rename(session.srcDir, tombstone)
    } catch (error) {
      // 源被占用 ⇒ 有写入方（DSH 多半还在跑）。**绝不硬来**：把刚写出来的目标撤掉，保持现场干净。
      await rm(dirname(session.dstLog), { recursive: true, force: true })
      return {
        ok: false,
        reason: 'source-locked',
        sessionId: session.sessionId,
        detail: String(error),
        backupDir,
        migrated: migrated.length,
        sessionIds: migrated,
        hint: '源会话日志被占用 ⇒ DSH 很可能还在运行。请完全退出 DSH 后重跑'
          + '（这正是 --i-have-stopped-dsh 这道闸门要防的情形）。源与目标都已复原，没有数据改动。'
      }
    }
    tombstones.push({
      sessionId: session.sessionId,
      dir: tombstone,
      logPath: join(tombstone, session.logFile),
      size: (await stat(join(tombstone, session.logFile))).size
    })
    migrated.push(session.sessionId)
  }

  // ⑤ 静默窗口：确认**没有人在写**墓碑。有人在写 ⇒ 说明"DSH 已停机"这个前提不成立，
  // 数据（包括迁移之后新写的事件）都还在墓碑里 —— 保留它，并如实报错。
  const settleMs = Number.isSafeInteger(options?.settleMs) && options.settleMs >= 0 ? options.settleMs : 1200
  const stillWriting = []
  if (tombstones.length > 0) {
    await sleep(settleMs)
    for (const entry of tombstones) {
      const sizeAfter = await stat(entry.logPath).then((info) => info.size, () => -1)
      if (sizeAfter !== entry.size) {
        stillWriting.push({
          sessionId: entry.sessionId,
          tombstone: entry.dir,
          sizeBefore: entry.size,
          sizeAfter,
          // 迁移之后新写的事件就在墓碑里 —— 用户可以自己捞，**没有丢**
          hint: `迁移之后新写的事件仍在 ${entry.dir}，可用它补齐或据此回滚`
        })
      }
    }
  }
  // 没人写 ⇒ 清掉墓碑（等价于原来的"删源"）；有人在写 ⇒ 一律保留，绝不删。
  const stillWritingIds = new Set(stillWriting.map((item) => item.sessionId))
  const removed = []
  for (const entry of tombstones) {
    if (stillWritingIds.has(entry.sessionId)) continue
    await rm(entry.dir, { recursive: true, force: true })
    removed.push(entry.sessionId)
  }

  // ⑤ 写意图给在线层。**哪怕是部分成功也要写** —— 已经搬过去的那些确实需要被挂回新工作区。
  //
  // 顺序刻意按 `createdAt` **升序**：在线层是逐个 `attachSession`，而官方 `attachSession` 是
  // **前插** ⇒ 升序挂完，新组里的顺序正好是官方惯例的"新的在前"。
  let intentWritten = null
  if (intentPath !== null && migrated.length > 0) {
    const ordered = plan.sessions
      .filter((session) => migrated.includes(session.sessionId))
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
      .map((session) => session.sessionId)
    try {
      await writeMigrationIntent(intentPath, {
        fromCwd: plan.fromCwd,
        toCwd: plan.toCwd,
        backupDir,
        sessionIds: ordered
      })
      intentWritten = intentPath
    } catch (error) {
      return { ok: false, reason: `intent-write-failed: ${String(error)}`, backupDir, migrated: migrated.length, sessionIds: migrated }
    }
  }

  return {
    // ⚠️ 探测到"还在被写"就是**失败**：`--i-have-stopped-dsh` 这个前提不成立，
    // 用户必须知道。但**数据没丢** —— 迁移之后新写的事件都在墓碑里（见 `stillWriting[].hint`）。
    ok: stillWriting.length === 0,
    reason: stillWriting.length === 0 ? undefined : 'source-still-being-written',
    stillWriting,
    backupDir,
    migrated: migrated.length,
    sessionIds: migrated,
    intentPath: intentWritten,
    tombstonesRemoved: removed.length
  }
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

  // 会话已经放回原位了 ⇒ 那份还没被在线层消费的意图必须清掉，否则插件会把它们挂到目标组去。
  let clearedIntent = null
  if (typeof manifest.intentPath === 'string' && manifest.intentPath.length > 0) {
    try {
      await rm(manifest.intentPath, { force: true })
      clearedIntent = manifest.intentPath
    } catch { /* 删不掉就让插件去处理，反正它只在文件存在时才动 */ }
  }

  return { ok: true, restored: restored.length, sessionIds: restored, clearedIntent }
}
