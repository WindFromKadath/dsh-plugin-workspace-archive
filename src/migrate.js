/**
 * 在线层 · 迁移意图的**纯决策**（不做任何 I/O）。
 *
 * ## 分工
 *
 *   - **离线层**（`offline/apply.js`，CLI）负责改不了官方 API 的那部分：改写会话 header 的 cwd、
 *     把日志搬到新 `projectKey` 目录。它同时写一份**意图**，说明"这些会话现在属于哪个路径了"。
 *   - **在线层**（本模块 + `src/index.js` 的接线）负责**只走官方 API** 的那部分：把会话
 *     `attachSession` 到新路径的工作区、从旧工作区 `detachSession`。
 *
 * ## 为什么归档态不用管
 *
 * 官方归档集合是**会话 id 的全局集合**，与 cwd、与工作区都无关。离线改 cwd 不会动它，
 * `attachSession` 也不看它 ⇒ **原本归档的会话在新组里仍然归档**，天然成立、无需补偿。
 * （这条有测试守着，见 `tests/migrate.test.mjs` 与真机阶段 9。）
 *
 * ## 为什么用 `list()` 匹配路径而不是 `resolveByPath()`
 *
 * 改名的场景里**旧路径已经不存在了**，而官方 `resolveByPath` 会对路径做 `realpath` ——
 * 路径不存在时它 **reject**。所以源工作区只能按 `list()` 里的 `path` 字符串找。
 *
 * @module dsh-plugin-workspace-archive/migrate
 */

import { pathKey } from './ledger.js'

/**
 * 解析离线层写下的意图文件。**纯函数**，失败一律 fail-closed。
 * @param text - 文件内容。
 * @returns `{ ok: true, intent }` 或 `{ ok: false, reason }`。
 */
export function parseMigrationIntent(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `intent-is-not-json: ${String(error)}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'intent-is-not-an-object' }
  }
  if (value.version !== 1) return { ok: false, reason: `unsupported-intent-version (${String(value.version)})` }
  if (typeof value.toCwd !== 'string' || value.toCwd.length === 0) return { ok: false, reason: 'intent-has-no-toCwd' }
  if (Array.isArray(value.sessions) === false) return { ok: false, reason: 'intent-has-no-sessions-array' }
  const sessions = value.sessions.filter((id) => typeof id === 'string' && id.length > 0)
  if (sessions.length !== value.sessions.length) return { ok: false, reason: 'intent-sessions-must-be-non-empty-strings' }
  if (sessions.length === 0) return { ok: false, reason: 'intent-has-no-sessions' }
  return {
    ok: true,
    intent: {
      version: 1,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
      fromCwd: typeof value.fromCwd === 'string' ? value.fromCwd : null,
      toCwd: value.toCwd,
      backupDir: typeof value.backupDir === 'string' ? value.backupDir : null,
      sessions
    }
  }
}

/** 在 `list()` 里按路径找工作区（用与台账同口径的归一化键）。 */
function findByPath(workspaces, cwd) {
  if (cwd === null) return undefined
  const key = pathKey(cwd)
  return workspaces.find((workspace) => pathKey(workspace.path) === key)
}

/**
 * 算出这一轮该对哪些会话 `attach` / `detach`。**纯函数**。
 *
 * @param intent - `parseMigrationIntent()` 的 `intent`。
 * @param workspaces - 注册表投影数组，每项 `{ id, path, sessionIds }`。
 * @returns `{ ok, target, source, attach, detach, reason }`。
 */
export function planMigrationStep(intent, workspaces) {
  const target = findByPath(workspaces, intent.toCwd)
  if (target === undefined) {
    return { ok: false, reason: `target-workspace-not-registered (${intent.toCwd})`, attach: [], detach: [] }
  }
  const source = findByPath(workspaces, intent.fromCwd)

  const attach = intent.sessions.filter((id) => target.sessionIds.includes(id) === false)
  const detach = source === undefined
    ? []
    : intent.sessions.filter((id) => source.sessionIds.includes(id) === true)

  return {
    ok: true,
    target: { id: target.id, path: target.path },
    source: source === undefined ? null : { id: source.id, path: source.path },
    attach,
    detach,
    // 已经全都在位、且旧组也不留人 ⇒ 无事可做（幂等：重跑同一份意图是安全的）。
    noop: attach.length === 0 && detach.length === 0
  }
}
