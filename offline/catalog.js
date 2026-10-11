/**
 * 离线迁移引擎 · 会话目录（**只读**）：按 id 定位、列清单、读标题投影。
 *
 * 让"**单个对话**"可以被手动迁移：不必先知道它属于哪个 cwd —— 由它自己的 header 说了算。
 *
 * ## 定位为什么便宜
 *
 * 官方日志位置是 `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`。所以按 id 找一条会话，
 * 只要对 `sessions/` 下的每个 project 目录做一次 `stat`（通常几个到几十个），**不用扫全部日志**。
 *
 * ## 标题从哪来
 *
 * `storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val` 就是侧栏那个标题；
 * 同一个文件里的 `record.rows.sessionListMetadata.val.blank` 是**官方**的"空白会话"位
 * （`SessionListMetadata.blank`，"前缀里没有 turn"）—— 离线可读，所以 `list` 用它，不自造判据。
 *
 * ⚠️ 投影只用于**显示**：解析不出来就返回 `null`，绝不参与任何决策。
 *
 * @module dsh-plugin-workspace-archive/offline/catalog
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { encodeSegment, readHeaderPrefix } from './frames.js'

/** 一个 project 目录下的日志文件名（只认官方规范名）。 */
const LOG_SUFFIX = '.jsonl.zstd'

async function readdirSafe(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 按会话 id 定位它的日志。
 * @param sessionsRoot - `sessions/` 根。
 * @param sessionId - 会话 id。
 * @returns `{ projectDir, sessionDir, logFile, logPath }` 或 `null`。
 */
export async function locateSession(sessionsRoot, sessionId) {
  const encoded = encodeSegment(sessionId)
  for (const project of await readdirSafe(sessionsRoot)) {
    if (project.isDirectory() === false) continue
    const sessionDir = join(sessionsRoot, project.name, encoded)
    let info
    try {
      info = await stat(sessionDir)
    } catch {
      continue
    }
    if (info.isDirectory() === false) continue
    const files = (await readdirSafe(sessionDir)).filter((entry) => entry.isFile()).map((entry) => entry.name)
    const logFile = files.find((name) => name.endsWith(LOG_SUFFIX))
    if (logFile === undefined) continue
    return { projectDir: join(sessionsRoot, project.name), sessionDir, logFile, logPath: join(sessionDir, logFile) }
  }
  return null
}

/**
 * 读一条会话的**标题投影**（只读 projcache）。拿不到就 `null` —— 绝不因此失败。
 * @param projCacheRoot - `storages/session_projcache` 目录。
 * @param sessionId - 会话 id。
 * @returns `{ title, blank, cwd }` 或 `null`。
 */
export async function readProjection(projCacheRoot, sessionId) {
  if (typeof projCacheRoot !== 'string' || projCacheRoot.length === 0) return null
  try {
    const value = JSON.parse(await readFile(join(projCacheRoot, 'sessions', `${sessionId}.json`), 'utf8'))
    const record = value?.record
    return {
      title: typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : null,
      blank: record?.rows?.sessionListMetadata?.val?.blank ?? null,
      cwd: typeof record?.identity?.cwd === 'string' ? record.identity.cwd : null
    }
  } catch {
    return null
  }
}

/**
 * 列出会话（只读）。**按 id 迁移的入口**：用户先在这里认出要迁的那条对话。
 * @param options - `{ sessionsRoot, projCacheRoot, cwd }`；`cwd` 可选，只看某个工作区下的会话。
 * @returns 会话数组，按 `createdAt` 倒序（与侧栏一致）。
 */
export async function listSessions(options) {
  const { sessionsRoot } = options
  const projCacheRoot = options.projCacheRoot ?? null
  const onlyCwd = options.cwd ?? null
  const sessions = []

  for (const project of await readdirSafe(sessionsRoot)) {
    if (project.isDirectory() === false) continue
    const projectDir = join(sessionsRoot, project.name)
    for (const entry of await readdirSafe(projectDir)) {
      if (entry.isDirectory() === false) continue
      const sessionDir = join(projectDir, entry.name)
      const files = (await readdirSafe(sessionDir)).filter((item) => item.isFile()).map((item) => item.name)
      const logFile = files.find((name) => name.endsWith(LOG_SUFFIX))
      if (logFile === undefined) continue
      const logPath = join(sessionDir, logFile)

      const header = await readHeaderPrefix(logPath)
      if (header.ok !== true) continue
      if (onlyCwd !== null && header.header.cwd !== onlyCwd) continue

      const sessionId = typeof header.header.id === 'string' ? header.header.id : entry.name
      const projection = await readProjection(projCacheRoot, sessionId)
      sessions.push({
        sessionId,
        cwd: header.header.cwd,
        createdAt: header.header.createdAt ?? null,
        version: header.header.version ?? null,
        bytes: (await stat(logPath)).size,
        title: projection?.title ?? null,
        blank: projection?.blank ?? null,
        projectDirName: project.name
      })
    }
  }
  return sessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
}

/**
 * 把会话清单渲染成人看的文本（纯函数）。
 * @param sessions - `listSessions()` 的返回值。
 * @param options - `{ showBlank }`：是否也列出空白会话（默认列出，但标记出来）。
 * @returns 多行字符串。
 */
export function describeSessions(sessions, options = {}) {
  const showBlank = options.showBlank ?? true
  const visible = showBlank ? sessions : sessions.filter((item) => item.blank !== true)
  const lines = []
  for (const session of visible) {
    const title = session.title === null ? '(没有标题)' : session.title
    const tags = []
    if (session.blank === true) tags.push('空白会话')
    if (session.blank === null) tags.push('无投影')
    lines.push(`  ${session.sessionId}`)
    lines.push(`      ${title}${tags.length > 0 ? `   [${tags.join(' ')}]` : ''}`)
    lines.push(`      ${session.cwd ?? '(无 cwd)'}   ${session.bytes} 字节`)
  }
  if (visible.length === 0) lines.push('  （没有会话）')
  return lines.join('\n')
}
