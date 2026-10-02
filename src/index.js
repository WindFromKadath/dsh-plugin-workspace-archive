/**
 * dsh-plugin-workspace-archive — DSH 宿主侧插件（F002 骨架）。
 *
 * 目标（需求②）：工作区目录被删除/移走后，把它下面**由本插件登记过的**会话
 * 归档；同一个目录回来后，**只**恢复这批会话，绝不碰用户自己手动归档的会话。
 *
 * 只走官方入口（勘察依据见 docs/recon/02-workspace-session-archive.md）：
 *   - `ctx.workspaceRegistry.list()`            → 注册表里的 Workspace 记录
 *   - `Workspace.status()`                      → 'ok' | 'missing-dir'
 *   - `ctx.workspaceRegistry.archiveSession()`  → 归档（可抛 WorkspaceActiveSessionError）
 *   - `ctx.workspaceRegistry.unarchiveSession()`→ 恢复
 * 不写 `~/.dsh/storages/workspace.json`，不改官方包。
 *
 * 硬约束（实现时必须守）：
 *   1. 目录消失不产生任何事件 → 只能轮询，且要能容忍抖动（连续 N 次确认）。
 *   2. 目录消失后，下一次任何 workspace 写操作会把这些失效会话 id 从注册表记录里
 *      **永久 prune** → 必须在判定 missing 的第一时间把 id 写进 sidecar 台账。
 *   3. 重新添加目录会**新建空项目（新 workspaceId）** → 恢复只能靠台账里的路径，
 *      不能靠 workspaceId 认亲。
 *   4. `archivedSessionIds` 是纯字符串数组、无来源标记 → 恢复只处理台账交集。
 *
 * 本文件当前只是骨架：apply() 校验配置、记录一行日志，不做任何读写与定时。
 *
 * @module dsh-plugin-workspace-archive
 */

import z from '@deepseek-ai/schemastery'

/** Loader 行名。 */
export const name = 'dsh-plugin-workspace-archive'

/** 需要的宿主服务：工作区注册表是归档/恢复的唯一官方入口。 */
export const inject = ['workspaceRegistry']

/**
 * 插件配置（`cordis.patch.yml` 里 `workspace-archive` 行的 `config:`）。
 * 全部字段都带默认值，行上不写 config 也能加载。
 */
export const Config = z.object({
  /** 轮询间隔（毫秒）。目录消失没有事件，只能定时对账。 */
  pollIntervalMs: z.number().step(1000).min(10000).default(60000),
  /** 连续多少次探测到目录缺失才判定为 missing（抗重命名/同步软件抖动）。 */
  missingConfirmations: z.number().step(1).min(1).default(3),
  /** sidecar 台账文件名（相对本插件自己的存储目录；F003 决定物理位置）。 */
  ledgerFile: z.string().default('workspace-archive-ledger.json'),
  /** true 时只记录将要做的动作、不真正调用归档/恢复（第一次真机演练用）。 */
  dryRun: z.boolean().default(true)
})

/**
 * 即使 apply 被 Loader 之外的调用方直接调用（不做 Config 归一化）也校验一遍配置。
 * @param config - 原始或已归一的配置对象。
 * @returns 带默认值的配置。
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const resolved = {
    pollIntervalMs: raw.pollIntervalMs ?? 60000,
    missingConfirmations: raw.missingConfirmations ?? 3,
    ledgerFile: raw.ledgerFile ?? 'workspace-archive-ledger.json',
    dryRun: raw.dryRun ?? true
  }
  if (!Number.isSafeInteger(resolved.pollIntervalMs) || resolved.pollIntervalMs < 10000) {
    throw new TypeError('workspace-archive config pollIntervalMs must be a safe integer >= 10000')
  }
  if (!Number.isSafeInteger(resolved.missingConfirmations) || resolved.missingConfirmations < 1) {
    throw new TypeError('workspace-archive config missingConfirmations must be a positive safe integer')
  }
  if (typeof resolved.ledgerFile !== 'string' || resolved.ledgerFile.length === 0) {
    throw new TypeError('workspace-archive config ledgerFile must be a non-empty string')
  }
  if (typeof resolved.dryRun !== 'boolean') {
    throw new TypeError('workspace-archive config dryRun must be a boolean')
  }
  return resolved
}

/**
 * 装载插件。F002 骨架：只校验配置并报告就绪，不注册定时器、不读写数据。
 * @param ctx - Cordis 上下文（需要 `workspaceRegistry`；`logger` 可选，便于直接测试）。
 * @param config - 行配置。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const registry = ctx?.workspaceRegistry
  const known = typeof registry?.list === 'function' ? registry.list().length : 0
  ctx?.logger?.info?.(
    'workspace-archive: 骨架已装载（未启用轮询）'
      + ` pollIntervalMs=${resolved.pollIntervalMs}`
      + ` missingConfirmations=${resolved.missingConfirmations}`
      + ` ledgerFile=${resolved.ledgerFile}`
      + ` dryRun=${resolved.dryRun}`
      + ` workspaces=${known}`
  )
}
