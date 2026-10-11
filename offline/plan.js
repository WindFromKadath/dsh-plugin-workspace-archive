/**
 * 离线迁移引擎 · 只读预检与计划（**零写入**）。
 *
 * 职责边界：
 *   - 本模块**只读**文件系统：`readdir` / `readFile` / `stat`，绝不写。
 *   - 真正的落盘（备份、改写、搬目录、回滚）在写入层，且**只应该由 CLI 在计划通过后调用**。
 *
 * 为什么能只按 cwd 找到会话：官方日志位置完全由 header 的 cwd 决定
 * （`projectDir = join(root, projectKey(cwd))`），所以"cwd 等于 X 的会话"必然在
 * `<root>/<projectKey(X)>/` 下。我们仍然**逐条读 header 复核**，不匹配就报阻塞。
 *
 * @module dsh-plugin-workspace-archive/offline/plan
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { projectKey, readHeader, rewriteHeaderCwd, scanFrames, sessionLogFilename } from './frames.js'

/** 判断一个路径是不是存在的目录。 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 扫一个 cwd 对应的 project 目录，逐条读出会话与它们的 header。
 * @param sessionsRoot - `sessions/` 根。
 * @param cwd - 会话的 cwd（工作区路径）。
 * @returns `{ projectDir, entries }`；`entries[].blocks` 是**逐条**阻塞项（不阻断其它条目）。
 */
export async function collectSessions(sessionsRoot, cwd) {
  const projectDir = join(sessionsRoot, projectKey(cwd))
  let dirents
  try {
    dirents = await readdir(projectDir, { withFileTypes: true })
  } catch {
    return { projectDir, entries: [] }
  }

  const entries = []
  for (const dirent of dirents) {
    if (dirent.isDirectory() === false) continue
    const sessionDir = join(projectDir, dirent.name)
    const blocks = []
    let files = []
    try {
      files = await readdir(sessionDir)
    } catch {
      blocks.push('session-dir-unreadable')
    }
    // 只认**官方规范名**推导出来的那个文件：`session.vN.jsonl.zstd`。
    // 其它名字（临时文件、旧代际残留）不作数，也不猜。
    const logFile = files.find((name) => name.endsWith('.jsonl.zstd'))
    if (logFile === undefined) {
      entries.push({ sessionId: dirent.name, sessionDir, logFile: null, blocks: [...blocks, 'no-log-file'] })
      continue
    }

    const logPath = join(sessionDir, logFile)
    let buffer
    try {
      buffer = await readFile(logPath)
    } catch {
      entries.push({ sessionId: dirent.name, sessionDir, logFile, blocks: [...blocks, 'log-unreadable'] })
      continue
    }

    const header = readHeader(buffer)
    if (header.ok !== true) {
      entries.push({
        sessionId: dirent.name,
        sessionDir,
        logFile,
        bytes: buffer.length,
        blocks: [...blocks, `header-unreadable: ${header.reason}`]
      })
      continue
    }

    // 文件名必须与 header 的代际一致 —— 不一致说明这条日志不是这个名字该有的那条。
    const expected = sessionLogFilename(header.header.version)
    if (expected !== logFile) blocks.push(`log-name-generation-mismatch (header v${header.header.version} ⇒ ${expected})`)
    // cwd 必须就是我们要迁的那个，否则拒绝（拒绝猜测）。
    if (header.header.cwd !== cwd) blocks.push(`header-cwd-mismatch (${header.header.cwd})`)

    const frames = scanFrames(buffer)
    if (frames.trailing !== null) blocks.push('trailing-bytes-after-last-frame')

    entries.push({
      sessionId: dirent.name,
      sessionDir,
      logPath,
      logFile,
      bytes: buffer.length,
      frameCount: frames.frames.length,
      firstFrameBytes: frames.frames[0]?.end ?? null,
      version: header.header.version,
      createdAt: header.header.createdAt,
      isSeeded: header.header.isSeeded,
      headerCwd: header.header.cwd,
      blocks
    })
  }
  return { projectDir, entries }
}

/**
 * 产出一份**只读**迁移计划。不改任何文件。
 *
 * @param options - `{ sessionsRoot, fromCwd, toCwd, only }`；`only` 是可选会话 id 白名单。
 * @returns 计划对象（可直接 JSON 序列化）。
 */
export async function buildPlan(options) {
  const { sessionsRoot, fromCwd, toCwd } = options
  const only = options.only === undefined ? null : new Set(options.only)

  const blockers = []
  if (await isDirectory(sessionsRoot) === false) blockers.push(`sessions-root-missing (${sessionsRoot})`)
  const targetExists = await isDirectory(toCwd)
  if (targetExists === false) blockers.push(`target-cwd-is-not-an-existing-directory (${toCwd})`)

  const sourceProjectDir = join(sessionsRoot, projectKey(fromCwd))
  const targetProjectDir = join(sessionsRoot, projectKey(toCwd))
  const sourceExists = await isDirectory(sourceProjectDir)
  if (sourceExists === false) blockers.push(`source-project-dir-missing (${projectKey(fromCwd)})`)

  const collected = sourceExists ? await collectSessions(sessionsRoot, fromCwd) : { entries: [] }
  // 计划是**工作单元**：只要全局有阻塞，逐条一律标 blocked —— 否则写入层照 `action === 'move'`
  // 去做，就会在"目标目录根本不存在"的情况下动手。逐条自己的原因仍留在 `blocks` 里。
  const planBlocked = blockers.length > 0

  const sessions = []
  for (const entry of collected.entries) {
    if (only !== null && only.has(entry.sessionId) === false) continue
    const blocks = [...entry.blocks]
    const dstSessionDir = join(targetProjectDir, entry.sessionId)
    const dstLogPath = entry.logFile === null ? null : join(dstSessionDir, entry.logFile)

    if (await isDirectory(dstSessionDir)) blocks.push('target-session-dir-already-exists')
    if (projectKey(fromCwd) === projectKey(toCwd)) blocks.push('source-and-target-project-key-are-identical')

    // 试改一次（**在内存里**，不落盘）：任何一条过不了自检就阻塞。
    let rewrite = null
    if (blocks.length === 0 && entry.logPath !== undefined) {
      const buffer = await readFile(entry.logPath)
      rewrite = await rewriteHeaderCwd(buffer, toCwd)
      if (rewrite.ok !== true) blocks.push(`rewrite-would-fail: ${rewrite.reason}`)
    }

    sessions.push({
      sessionId: entry.sessionId,
      srcDir: entry.sessionDir,
      dstDir: dstSessionDir,
      srcLog: entry.logPath ?? null,
      dstLog: dstLogPath,
      bytes: entry.bytes ?? null,
      frameCount: entry.frameCount ?? null,
      version: entry.version ?? null,
      createdAt: entry.createdAt ?? null,
      headerCwd: entry.headerCwd ?? null,
      action: blocks.length === 0 && planBlocked === false ? 'move' : 'blocked',
      // 逐条本身没问题、但被整份计划的全局阻塞挡住 —— 渲染时要说清楚，别让人以为这条有问题。
      blockedByPlan: blocks.length === 0 && planBlocked,
      blocks,
      rewrite: rewrite === null || rewrite.ok !== true
        ? null
        : { changed: rewrite.changed, oldCwd: rewrite.oldCwd, header: rewrite.header }
    })
  }

  const movable = sessions.filter((item) => item.action === 'move').length
  return {
    ok: blockers.length === 0 && movable === sessions.length && sessions.length > 0,
    sessionsRoot,
    fromCwd,
    toCwd,
    sourceProjectDir,
    targetProjectDir,
    targetExists,
    blockers,
    sessions,
    summary: { total: sessions.length, movable, blocked: sessions.length - movable }
  }
}

/**
 * 把计划渲染成人看的文本（纯函数）。不做任何 I/O。
 * @param plan - `buildPlan()` 的返回值。
 * @returns 多行字符串。
 */
export function describePlan(plan) {
  const lines = []
  lines.push(`迁移计划（只读预演 —— 本命令不写任何文件）`)
  lines.push(`  会话根        ${plan.sessionsRoot}`)
  lines.push(`  从            ${plan.fromCwd}`)
  lines.push(`  到            ${plan.toCwd}`)
  lines.push(`  源 project    ${plan.sourceProjectDir}`)
  lines.push(`  目标 project  ${plan.targetProjectDir}${plan.targetExists ? '' : '  ← 目标目录不存在'}`)
  lines.push('')
  if (plan.blockers.length > 0) {
    lines.push(`全局阻塞（${plan.blockers.length}）：`)
    for (const blocker of plan.blockers) lines.push(`  ✖ ${blocker}`)
    lines.push('')
  }
  lines.push(`会话（${plan.summary.total}）：`)
  for (const session of plan.sessions) {
    const mark = session.action === 'move' ? '✔' : '✖'
    lines.push(`  ${mark} ${session.sessionId}`)
    lines.push(`      ${session.bytes ?? '?'} 字节 / ${session.frameCount ?? '?'} 帧 / v${session.version ?? '?'} / cwd=${session.headerCwd ?? '?'}`)
    if (session.action === 'move') {
      lines.push(`      → 改第 0 帧的 cwd，并搬到 ${session.dstDir}`)
    } else if (session.blockedByPlan === true) {
      lines.push('      阻塞：整份计划被上面的全局阻塞挡住（这条本身没问题）')
    } else {
      for (const block of session.blocks) lines.push(`      阻塞：${block}`)
    }
  }
  lines.push('')
  lines.push(`小计：可迁移 ${plan.summary.movable} / 共 ${plan.summary.total}；阻塞 ${plan.summary.blocked}`)
  lines.push(`结论：${plan.ok ? '计划可用' : '计划**不可用**（上面有阻塞）'}`)
  return lines.join('\n')
}
