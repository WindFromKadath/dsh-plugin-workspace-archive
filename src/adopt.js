/**
 * T0「无项目 → 按 cwd 归位」。
 *
 * 为什么需要它：官方工作区注册表**只在第一次启动时**按 `header.cwd` 把已有会话归组
 * （bootstrap 一次性，写 initialized 标记后永不再跑），此后"会话落在「无项目」里而它的
 * cwd 明明就是某个已登记工作区的路径"这种状态**没有任何官方通道能自愈**。典型成因：
 * 「删除工作区 → 重新添加同一目录」发生在插件没运行的时候；或先有会话、后来才登记该目录。
 *
 * 这一步**只做两件事**，都走官方入口：
 *   1. 只读：`ctx.sessionPersistence.list()` 拿每个已存会话的 header（含 `cwd`）+
 *      `ctx.workspaceRegistry.list()` 拿工作区路径与成员表；
 *   2. 写入：对命中的会话调官方 `Workspace.attachSession(sessionId)`。
 *
 * 判据刻意收紧（避免变成"批量接管"）：
 *   - 会话**不在任何**工作区的成员表里（真·未分组）；
 *   - `realpath(cwd)` 与某工作区路径**精确相等**（不做前缀/父目录/子目录匹配）；
 *   - `cwd` 解析不了（目录已不在）直接跳过 —— `attachSession` 同样会拒，不做无谓尝试；
 *   - **绝不**碰 `archivedSessionIds`，也**绝不**直写任何存储文件。
 *
 * 官方 `attachSession` 自己还会复核一次（`dsh-workspace/lib/index.js:111-129`：header 必须有
 * cwd → `realpathNormalize` → 必须是目录 → 必须精确等于 `record.path`），且它是**前插**，
 * 所以这里按 `createdAt` 升序下发，挂完才是官方惯例的"新的在前"。
 *
 * @module dsh-plugin-workspace-archive/adopt
 */

import { realpath } from 'node:fs/promises'

import { pathKey } from './ledger.js'

/**
 * 纯选择：从"全部已存会话"与"全部工作区"里挑出该归位的会话。
 *
 * @param options - 入参。
 * @param options.workspaces - 官方工作区实体（至少要有 `id` / `path` / `sessionIds`）。
 * @param options.sessions - `{ id, cwd, createdAt }`，`cwd` 已由调用方 `realpath` 规范化。
 * @param options.keyOf - 路径归一函数（默认 `ledger.pathKey`：Windows 下大小写不敏感）。
 * @returns 每个工作区一条 `{ workspaceId, path, sessionIds }`；`sessionIds` 已按 createdAt 升序。
 */
export function selectAdoptions({ workspaces, sessions, keyOf = pathKey }) {
  const accounted = new Set()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) accounted.add(sessionId)
  }
  const byPath = new Map()
  for (const workspace of workspaces) {
    const key = keyOf(workspace.path)
    if (byPath.has(key) === false) byPath.set(key, { workspace, candidates: [] })
  }
  for (const session of sessions) {
    if (typeof session?.id !== 'string' || accounted.has(session.id)) continue
    if (typeof session.cwd !== 'string' || session.cwd.length === 0) continue
    const bucket = byPath.get(keyOf(session.cwd))
    if (bucket === undefined) continue
    bucket.candidates.push(session)
  }
  const plan = []
  for (const { workspace, candidates } of byPath.values()) {
    if (candidates.length === 0) continue
    const ordered = [...candidates].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    plan.push({ workspaceId: workspace.id, path: workspace.path, sessionIds: ordered.map((entry) => entry.id) })
  }
  return plan
}

/**
 * 跑一次归位。**只调用官方 API**，失败逐条记日志、绝不中断其余会话。
 *
 * @param options - 依赖注入（测试可全部替换）。
 * @param options.registry - `ctx.workspaceRegistry`。
 * @param options.persistence - `ctx.sessionPersistence`（只读 `list()`）。
 * @param options.logger - 可选日志。
 * @param options.dryRun - 为真时只记日志、不调 `attachSession`。
 * @param options.realpathFn - `cwd` 规范化实现（默认 `node:fs/promises` 的 `realpath`）。
 * @param options.keyOf - 路径归一函数。
 * @returns 真正挂回的会话 id 列表。
 */
export async function adoptUngrouped({
  registry,
  persistence,
  logger,
  dryRun = true,
  realpathFn = realpath,
  keyOf = pathKey
} = {}) {
  if (registry === undefined || persistence === undefined) return []
  if (typeof registry.list !== 'function' || typeof persistence.list !== 'function') return []
  const workspaces = registry.list()
  if (workspaces.length === 0) return []
  const snapshots = await persistence.list()
  const sessions = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header === undefined || typeof header.id !== 'string') continue
    if (typeof header.cwd !== 'string' || header.cwd.length === 0) continue
    let cwd
    try {
      cwd = await realpathFn(header.cwd)
    } catch {
      continue // 目录已不在：官方 attachSession 也会拒
    }
    sessions.push({ id: header.id, cwd, createdAt: header.createdAt })
  }
  const plan = selectAdoptions({ workspaces, sessions, keyOf })
  const adopted = []
  for (const action of plan) {
    const workspace = workspaces.find((candidate) => candidate.id === action.workspaceId)
    if (workspace === undefined || typeof workspace.attachSession !== 'function') continue
    for (const sessionId of action.sessionIds) {
      if (dryRun) {
        logger?.info?.(`workspace-archive[dryRun]: 将把无项目的 ${sessionId} 归位到 ${action.path}`)
        continue
      }
      try {
        await workspace.attachSession(sessionId)
        adopted.push(sessionId)
        logger?.info?.(`workspace-archive: 已把无项目的 ${sessionId} 归位到 ${action.path}`)
      } catch (error) {
        logger?.warn?.(`workspace-archive: 归位 ${sessionId} 失败（${action.path}）：${String(error)}`)
      }
    }
  }
  return adopted
}
