/**
 * dsh-plugin-workspace-archive — DSH 宿主侧插件。
 *
 * 需求②：工作区目录被删除/移走后，把它下面**由本插件登记过的**会话归档；
 * 同一个目录回来后，**只**恢复这批会话，绝不碰用户自己手动归档的会话。
 *
 * 三层结构（各自可单独测试）：
 *   - `src/ledger.js`  sidecar 台账：路径 → 会话 id，先落盘再动官方归档；
 *   - `src/policy.js`  纯决策：去抖后决定这一轮归档谁、恢复谁；
 *   - 本文件          接线：读官方注册表、执行官方 API、管定时器与 dryRun。
 *
 * 只走官方入口：`ctx.workspaceRegistry.list()` / `Workspace.status()` /
 * `archiveSession()` / `unarchiveSession()`。不写 `~/.dsh/storages/workspace.json`，
 * 不改官方包。
 *
 * 硬约束（勘察依据 docs/recon/02-workspace-session-archive.md §3.5）：
 *   1. 目录消失没有事件 → 轮询 + 去抖；
 *   2. 失效 id 会被下一次 workspace 写操作永久 prune → 健康时就把 id 记进台账；
 *   3. 重新添加目录会新建空项目 → 恢复靠台账路径，不靠 workspaceId；
 *   4. `archivedSessionIds` 无来源标记 → 恢复只处理台账交集。
 *
 * @module dsh-plugin-workspace-archive
 */

import { stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { LedgerStore } from './ledger.js'
import { createProbeState, evaluate } from './policy.js'

/** Loader 行名。 */
export const name = 'dsh-plugin-workspace-archive'

/** 需要的宿主服务：工作区注册表是归档/恢复的唯一官方入口。 */
export const inject = ['workspaceRegistry']

/** 配置（`cordis.patch.yml` 里 `workspace-archive` 行的 `config:`）。 */
export const Config = z.object({
  /** 轮询间隔（毫秒）；目录消失没有事件，只能定时对账。 */
  pollIntervalMs: z.number().step(1000).min(10000).default(60000),
  /** 连续多少次探测到缺失才判定 missing（抗重命名/同步抖动）。 */
  missingConfirmations: z.number().step(1).min(1).default(3),
  /** sidecar 文件名（相对 `$DSH_HOME/workspace-archive/`）。 */
  ledgerFile: z.string().default('ledger.json'),
  /** 显式台账绝对路径；留空则用 `$DSH_HOME/workspace-archive/<ledgerFile>`。 */
  ledgerPath: z.string().default(''),
  /** true 时只记录将要做的动作，不调官方归档/恢复、不写台账（首次真机演练）。 */
  dryRun: z.boolean().default(true)
})

/**
 * 即使 apply 被 Loader 之外的调用方直接调用也校验一遍配置。
 * @param config - 原始或已归一的配置对象。
 * @returns 带默认值的配置。
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const resolved = {
    pollIntervalMs: raw.pollIntervalMs ?? 60000,
    missingConfirmations: raw.missingConfirmations ?? 3,
    ledgerFile: raw.ledgerFile ?? 'ledger.json',
    ledgerPath: raw.ledgerPath ?? '',
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
  if (typeof resolved.ledgerPath !== 'string') {
    throw new TypeError('workspace-archive config ledgerPath must be a string (empty = derive from DSH home)')
  }
  if (typeof resolved.dryRun !== 'boolean') {
    throw new TypeError('workspace-archive config dryRun must be a boolean')
  }
  return resolved
}

/**
 * 解析台账绝对路径。
 * @param config - 已归一化配置。
 * @returns 绝对路径。
 */
export function resolveLedgerPath(config) {
  if (config.ledgerPath.length > 0) return config.ledgerPath
  return dshHomePath('workspace-archive', config.ledgerFile)
}

/**
 * 判断一个归档失败是不是「会话仍在跑」的官方拒绝。
 * 不 import `@deepseek-ai/dsh-workspace`（保持零额外 peer）：按错误名与 `activity` 字段识别。
 * @param error - archiveSession 抛出的错误。
 * @returns 是否为活动拒绝。
 */
export function isActiveSessionRefusal(error) {
  return error?.name === 'WorkspaceActiveSessionError' || Array.isArray(error?.activity)
}

/**
 * 组装可测引擎：probe（读注册表 + 判存在）→ policy（决策）→ 执行（官方 API）。
 *
 * @param deps - 依赖注入，全部可替换。
 * @returns `{ tick }`。
 */
export function createEngine(deps) {
  const { registry, ledger, config, logger } = deps
  // dryRun 在整个引擎范围内意味着「不写盘」：无论 LedgerStore 是怎么构造的。
  if (config.dryRun === true) ledger.persist = false
  const statDirectory = deps.statDirectory ?? (async (path) => {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  })
  let probeState = createProbeState()

  /**
   * 读一次全量观察：注册表里的工作区 + 台账里独有的路径（已被移出注册表但目录可能回来）。
   * @returns observations 数组。
   */
  async function observe() {
    const observations = []
    const seen = new Set()
    for (const workspace of registry.list()) {
      const exists = (await workspace.status()) === 'ok'
      observations.push({
        path: workspace.path,
        title: workspace.title,
        sessionIds: [...workspace.sessionIds],
        exists
      })
      seen.add(workspace.path.toLowerCase())
    }
    for (const entry of ledger.entries()) {
      if (seen.has(entry.path.toLowerCase())) continue
      observations.push({
        path: entry.path,
        title: entry.title,
        sessionIds: [...(entry.sessionIds ?? [])],
        exists: await statDirectory(entry.path)
      })
    }
    return observations
  }

  /**
   * 归档一批会话：官方调用**之前**先落台账（硬约束 2）。
   * 执行前复核官方归档集合：已经被别人（用户自己/别的插件）归档的会话不是我们的账，
   * 记进来就会在恢复时把用户的手动归档一并解除。真机测试抓到的就是这个洞。
   * @param action - policy 给出的动作。
   */
  async function runArchive(action) {
    const alreadyArchived = new Set(registry.archivedSessionIds ?? [])
    const mine = action.sessionIds.filter((id) => !alreadyArchived.has(id))
    if (mine.length === 0) return

    ledger.recordArchived(action.path, mine)
    if (config.dryRun) {
      logger?.info?.(`workspace-archive[dryRun]: 将归档 ${mine.length} 个会话 @ ${action.path}`)
      return
    }
    await ledger.save()
    for (const sessionId of mine) {
      try {
        await registry.archiveSession(sessionId)
        logger?.info?.(`workspace-archive: 已归档 ${sessionId}（${action.path} 目录缺失）`)
      } catch (error) {
        if (isActiveSessionRefusal(error)) {
          // 会话还在跑：跳过，绝不强停用户正在进行的工作。
          logger?.warn?.(`workspace-archive: 跳过仍在运行的 ${sessionId}（${action.path}）`)
          continue
        }
        logger?.warn?.(`workspace-archive: 归档 ${sessionId} 失败：${String(error)}`)
      }
    }
  }

  /**
   * 恢复一批会话：只处理台账交集。
   * @param action - policy 给出的动作。
   */
  async function runUnarchive(action) {
    if (config.dryRun) {
      logger?.info?.(`workspace-archive[dryRun]: 将恢复 ${action.sessionIds.length} 个会话 @ ${action.path}`)
      return
    }
    const restored = []
    for (const sessionId of action.sessionIds) {
      try {
        await registry.unarchiveSession(sessionId)
        restored.push(sessionId)
        logger?.info?.(`workspace-archive: 已恢复 ${sessionId}（${action.path} 目录回归）`)
      } catch (error) {
        logger?.warn?.(`workspace-archive: 恢复 ${sessionId} 失败：${String(error)}`)
      }
    }
    if (restored.length > 0) {
      ledger.recordRestored(action.path, restored)
      await ledger.save()
    }
  }

  /** 跑一轮对账。 */
  async function tick() {
    const observations = await observe()
    const { actions, state } = evaluate({
      observations,
      state: probeState,
      confirmations: config.missingConfirmations,
      ledger,
      // 官方归档集合的当前快照：用来区分「用户手动归档」和「本插件归档」。
      alreadyArchived: new Set(registry.archivedSessionIds ?? [])
    })
    probeState = state
    for (const action of actions) {
      if (action.kind === 'archive') await runArchive(action)
      else if (action.kind === 'unarchive') await runUnarchive(action)
    }
    // 健康视图也要落盘：这就是「抢在官方 prune 之前」的那份记录。
    if (!config.dryRun && actions.every((action) => action.kind !== 'archive')) await ledger.save()
    return actions
  }

  return { tick }
}

/**
 * 安排轮询。定时器服务（`timer`，由 `@deepseek-ai/cordis-plugin-timer` 提供）是**可选**依赖：
 * 有就用它（句柄挂在当前 fiber 上，插件卸载自动清理）；没有就退化为全局定时器并在 dispose 时清掉。
 * 注意：不能直接读 `ctx.interval`——Cordis 对未 inject 的服务属性会抛
 * "cannot get property interval without inject"，所以走 `ctx.get('timer')`。
 *
 * @param ctx - Cordis 上下文。
 * @param run - 每轮回调。
 * @param intervalMs - 间隔毫秒。
 * @returns 定时器句柄或 undefined。
 */
export function scheduleInterval(ctx, run, intervalMs) {
  const timer = typeof ctx?.get === 'function' ? ctx.get('timer') : undefined
  if (typeof timer?.interval === 'function') return timer.interval(run, intervalMs)
  const handle = setInterval(run, intervalMs)
  if (typeof ctx?.on === 'function') ctx.on('dispose', () => clearInterval(handle))
  return handle
}

/**
 * 装载插件：载入台账、立即对账一次、按间隔轮询。
 * @param ctx - Cordis 上下文（需要 `workspaceRegistry`；`logger`、`timer` 可选）。
 * @param config - 行配置。
 * @returns 引擎句柄（便于测试与手动触发 tick）。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const registry = ctx?.workspaceRegistry
  if (registry === undefined) throw new Error('workspace-archive: 缺少 workspaceRegistry 服务')

  const ledger = new LedgerStore(resolveLedgerPath(resolved))
  const engine = createEngine({ registry, ledger, config: resolved, logger: ctx?.logger })

  const run = () => {
    engine.tick().catch((error) => ctx?.logger?.warn?.(`workspace-archive: 对账失败 ${String(error)}`))
  }

  ledger.load().then(run, run)
  scheduleInterval(ctx, run, resolved.pollIntervalMs)

  ctx?.logger?.info?.(
    'workspace-archive: 已装载'
      + ` pollIntervalMs=${resolved.pollIntervalMs}`
      + ` missingConfirmations=${resolved.missingConfirmations}`
      + ` dryRun=${resolved.dryRun}`
      + ` ledger=${ledger.file}`
  )

  return { engine, ledger }
}
