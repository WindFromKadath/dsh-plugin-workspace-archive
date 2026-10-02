/**
 * 决策层（纯函数，无 I/O）：把「一次探测看到的目录/登记状态」变成「这一轮该做什么」。
 *
 * 输入 observations：每个被跟踪的工作区一条
 *   { path, title, sessionIds, exists, reason }
 *   - path/sessionIds 来自官方注册表（`ctx.workspaceRegistry.list()` 的实体），
 *     登记被移除后来自插件自己的台账；
 *   - exists=false 有两种原因：`folder-missing`（目录不在）或 `unregistered`
 *     （项目登记被移除，即菜单里的「删除工作区」）。
 *
 * 输出 actions：
 *   { kind: 'archive',   path, sessionIds, reason }  确认消失 → 归档
 *   { kind: 'unarchive', path, sessionIds }          回来 → 只恢复本插件归档过的
 *
 * 确认模型是**时间型**（不是"连续 N 次轮询"）：第一次看到消失时记下时间戳，之后只要
 * 仍是消失且已过 `confirmDelayMs` 就归档。事件驱动（秒级触发）与兜底轮询共用这一套判定，
 * `confirmDelayMs = 0` 即"发现即归档"。
 *
 * @module dsh-plugin-workspace-archive/policy
 */

/** 新建探测状态。 */
export function createProbeState() {
  return { missingSince: new Map() }
}

/**
 * 计算这一轮的动作。
 * @param options - `observations` / `state` / `ledger` / `confirmDelayMs` / `now` / `alreadyArchived`。
 * @returns `{ actions, state }`（state 为新的确认状态）。
 */
export function evaluate(options) {
  const { observations, state, ledger } = options
  const confirmDelayMs = options.confirmDelayMs ?? 0
  const now = options.now ?? Date.now()
  const alreadyArchived = options.alreadyArchived ?? new Set()
  const next = { missingSince: new Map(state?.missingSince ?? []) }
  const actions = []

  for (const observation of observations) {
    const { path, title, sessionIds, exists } = observation
    const entry = ledger.entry(path)

    if (exists) {
      next.missingSince.delete(path)
      // 目录/登记在：刷新成员视图（这是「抢在官方 prune 之前」的那次记录）。
      ledger.syncHealthy(path, title, sessionIds)
      // 回来了且本插件归档过 → 只恢复台账交集。
      const restorable = ledger.entry(path)?.archivedSessionIds ?? []
      if (restorable.length > 0) {
        actions.push({ kind: 'unarchive', path, sessionIds: [...restorable] })
      }
      continue
    }

    if (entry === undefined) {
      // 从未健康过：没有台账，不认识这些 id，也就没什么可归档的。
      next.missingSince.delete(path)
      continue
    }

    const since = next.missingSince.get(path)
    if (since === undefined) {
      next.missingSince.set(path, now) // 第一次看到消失：开始计时，先不动手
      continue
    }
    if (now - since < confirmDelayMs) continue // 确认窗口内：再等等

    const pending = entry.archivedSessionIds ?? []
    // 已在官方归档集合里的会话**不是我们的账**：那是用户（或别的插件）手动归档的，
    // 记进来就会在恢复时把它一并解除归档。官方 archiveSession 对已归档 id 是幂等的，
    // 不复核这一点就永远发现不了。真机测试抓到的就是这个洞。
    const candidates = (entry.sessionIds ?? [])
      .filter((id) => !pending.includes(id) && !alreadyArchived.has(id))
    ledger.markMissing(path)
    if (candidates.length > 0) {
      actions.push({ kind: 'archive', path, sessionIds: candidates, reason: observation.reason ?? 'folder-missing' })
    }
  }

  return { actions, state: next }
}
