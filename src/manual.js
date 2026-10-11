/**
 * 手动归档一个工作区（F020）：纯决策，无 I/O。
 *
 * 与"目录消失自动归档"（`policy.js`）是**两条独立的路**：
 *  - 自动归档记进台账的 `archivedSessionIds`，目录回归时**自动**恢复；
 *  - 手动归档记进 `manualArchivedSessionIds`，**只有手动恢复**才撤销。
 * 两者永不交叉 —— 否则用户显式归档的一批会被"目录消失又回来"顺手放出来。
 *
 * 边界（沿用本插件纪律）：
 *  - 只处理**官方尚未归档**的会话。已在官方归档集合里的，可能是用户自己在官方 UI 里归档的，
 *    **绝不动它**（官方那侧是裸集合、无来源标记，我们无法区分，只能保守跳过）。
 *  - 只处理**该工作区成员表里**的会话；不按 cwd 反查。
 *
 * @module dsh-plugin-workspace-archive/manual
 */

/** Windows 路径大小写不敏感（与 ledger 的 pathKey 同口径）；其它平台按原样比较。 */
function fold(value) {
  const text = String(value)
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/**
 * 按路径或标题解析一个工作区。路径优先于标题。
 *
 * 刻意**不做模糊匹配**：解析不唯一时返回候选让调用方再问一次，而不是猜一个。
 * @param workspaces - 注册表投影数组，每项 `{ id, path, title, sessionIds }`。
 * @param query - 用户/模型给的路径或标题。
 * @returns `{ ok: true, workspace }` 或 `{ ok: false, reason, candidates? }`。
 */
export function resolveWorkspace(workspaces, query) {
  const raw = typeof query === 'string' ? query.trim() : ''
  if (raw.length === 0) return { ok: false, reason: 'empty-query' }

  const byPath = workspaces.filter((w) => fold(w.path) === fold(raw))
  if (byPath.length === 1) return { ok: true, workspace: byPath[0] }
  const byTitle = workspaces.filter((w) => fold(w.title) === fold(raw))
  if (byTitle.length === 1) return { ok: true, workspace: byTitle[0] }

  const pool = byPath.length > 0 ? byPath : byTitle
  if (pool.length === 0) return { ok: false, reason: 'not-found' }
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: pool.map((w) => ({ path: w.path, title: w.title }))
  }
}

/**
 * 算出这一轮要动哪些会话。
 *
 * `action === 'archive'`：该工作区成员里**官方尚未归档**的那些。
 * `action === 'unarchive'`：台账手动清单里的全部（不按当前成员表过滤 —— 会话可能已经离开分组，
 * 但我们归档过它，就该由我们放回来）。
 *
 * @param options - `workspace` / `alreadyArchived`（官方归档集合快照）/ `entry`（台账条目）/ `action`。
 * @returns `{ kind, sessionIds, skipped }`；`skipped` 是因"已在官方归档集合里"而未被接管的数量。
 */
export function planManual(options) {
  const { workspace, alreadyArchived, entry } = options
  const action = options.action === 'unarchive' ? 'unarchive' : 'archive'

  if (action === 'unarchive') {
    return { kind: 'unarchive', sessionIds: [...(entry?.manualArchivedSessionIds ?? [])], skipped: [] }
  }

  const members = workspace?.sessionIds ?? []
  const ours = new Set(entry?.manualArchivedSessionIds ?? [])
  const sessionIds = []
  const skipped = []
  for (const id of members) {
    // 官方已归档：可能是用户自己归档的（裸集合无法区分）⇒ 不接管、也不记进我们的清单。
    if (alreadyArchived.has(id) === true) { skipped.push(id); continue }
    if (ours.has(id) === true) { skipped.push(id); continue }
    sessionIds.push(id)
  }
  return { kind: 'archive', sessionIds, skipped }
}
