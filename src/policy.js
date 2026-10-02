/**
 * 决策层（纯函数，无 I/O）：把「一次探测看到的目录状态」变成「这一轮该做什么」。
 *
 * 输入 observations：每个工作区一条
 *   { path, title, sessionIds, exists }
 *   - path/sessionIds 来自官方注册表（`ctx.workspaceRegistry.list()` 的实体）
 *   - exists 来自 `Workspace.status() === 'ok'`，台账独有路径来自自己的 stat
 *
 * 输出 actions：
 *   { kind: 'archive',   path, sessionIds }  目录确认消失 → 归档
 *   { kind: 'unarchive', path, sessionIds }  目录回来了 → 只恢复本插件归档过的
 *   { kind: 'saved' }                        无需动作时的占位（不产生）
 *
 * 去抖：连续 `confirmations` 次探测到缺失才判定缺失（抗重命名、同步软件、编辑器抖动）。
 *
 * @module dsh-plugin-workspace-archive/policy
 */

/** 新建探测状态。 */
export function createProbeState() {
  return { missStreak: new Map() }
}

/**
 * 计算这一轮的动作。
 * @param options - 见模块注释。
 * @returns `{ actions, state }`（state 为新的去抖状态）。
 */
export function evaluate(options) {
  const { observations, state, confirmations, ledger } = options
  const next = { missStreak: new Map(state?.missStreak ?? []) }
  const actions = []

  for (const observation of observations) {
    const { path, title, sessionIds, exists } = observation
    const entry = ledger.entry(path)

    if (exists) {
      next.missStreak.set(path, 0)
      // 目录在：刷新成员视图（这是「抢在 prune 之前」的那次记录）。
      ledger.syncHealthy(path, title, sessionIds)
      // 目录回来了且本插件归档过 → 只恢复台账交集。
      const restorable = (ledger.entry(path)?.archivedSessionIds ?? [])
      if (restorable.length > 0) {
        actions.push({ kind: 'unarchive', path, sessionIds: [...restorable] })
      }
      continue
    }

    const streak = (next.missStreak.get(path) ?? 0) + 1
    next.missStreak.set(path, streak)
    if (entry === undefined) continue // 从未健康过：没有台账，不认识这些 id
    if (streak < confirmations) continue // 还没确认，继续观察

    const pending = entry.archivedSessionIds ?? []
    const candidates = (entry.sessionIds ?? []).filter((id) => !pending.includes(id))
    ledger.markMissing(path)
    if (candidates.length > 0) actions.push({ kind: 'archive', path, sessionIds: candidates })
  }

  return { actions, state: next }
}
