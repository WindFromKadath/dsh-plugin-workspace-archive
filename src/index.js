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
 *   4. `archivedSessionIds` 无来源标记 → 恢复只处理台账交集；
 *   5. 「删除工作区 → 重新添加同一目录」会新建**空成员**的项目 → 恢复时必须用官方
 *      `Workspace.attachSession` 把会话挂回去，否则它们散成「无项目」（2026-10-07 实测）。
 *
 * @module dsh-plugin-workspace-archive
 */

import { stat } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { adoptUngrouped } from './adopt.js'
import { LedgerStore, pathKey } from './ledger.js'
import { createProbeState, evaluate } from './policy.js'

/** Loader 行名。 */
export const name = 'dsh-plugin-workspace-archive'

/** 需要的宿主服务：工作区注册表是归档/恢复的唯一官方入口。 */
export const inject = ['workspaceRegistry']

/**
 * 配置（`cordis.patch.yml` 里 `workspace-archive` 行的 `config:`）。
 *
 * 这里**故意不导出 schemastery 的 `Config`**：本插件要能被 junction 装载，而
 * Node 按真实路径解析嵌套 import 时够不到宿主的 `@deepseek-ai/*`（实测：
 * 装载报 ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery）。所以本插件零外部依赖，
 * 配置校验与默认值全部由下面的 `resolveConfig` 负责。
 */

/**
 * 即使 apply 被 Loader 之外的调用方直接调用也校验一遍配置。
 * @param config - 原始或已归一的配置对象。
 * @returns 带默认值的配置。
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  const resolved = {
    /** 兜底轮询间隔：事件驱动是主路径，轮询只防 watcher/事件漏报。 */
    pollIntervalMs: raw.pollIntervalMs ?? 300000,
    /** 发现消失后等多久再确认（毫秒）。0 = 发现即归档。 */
    confirmDelayMs: raw.confirmDelayMs ?? 3000,
    /** 是否给工作区目录的父目录挂 fs.watch（事件驱动的主要来源之一）。 */
    watch: raw.watch ?? true,
    /**
     * 是否在启动后做一次「无项目 → 按 cwd 归位」：把**未分组**且 `cwd` 精确等于某工作区路径的
     * 会话用官方 `attachSession` 挂回去（见 `src/adopt.js`）。可关。
     */
    adoptUngrouped: raw.adoptUngrouped ?? true,
    /** 归位动作在启动后延迟多久执行（毫秒）：避开官方 registry bootstrap 的自己那一轮。 */
    adoptDelayMs: raw.adoptDelayMs ?? 5000,
    ledgerFile: raw.ledgerFile ?? 'ledger.json',
    ledgerPath: raw.ledgerPath ?? '',
    dryRun: raw.dryRun ?? true
  }
  if (!Number.isSafeInteger(resolved.pollIntervalMs) || resolved.pollIntervalMs < 1000) {
    throw new TypeError('workspace-archive config pollIntervalMs must be a safe integer >= 1000')
  }
  if (!Number.isSafeInteger(resolved.confirmDelayMs) || resolved.confirmDelayMs < 0) {
    throw new TypeError('workspace-archive config confirmDelayMs must be a non-negative safe integer')
  }
  if (typeof resolved.watch !== 'boolean') {
    throw new TypeError('workspace-archive config watch must be a boolean')
  }
  if (typeof resolved.adoptUngrouped !== 'boolean') {
    throw new TypeError('workspace-archive config adoptUngrouped must be a boolean')
  }
  if (!Number.isSafeInteger(resolved.adoptDelayMs) || resolved.adoptDelayMs < 0) {
    throw new TypeError('workspace-archive config adoptDelayMs must be a non-negative safe integer')
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
 * 解析 DSH 主目录。优先用宿主提供的 `dshHomePath` 服务（boot 会在根上下文提供它），
 * 否则退回 `$DSH_HOME`，最后是 `~/.dsh`。**不 import `@deepseek-ai/dsh-home-paths`**：
 * 那会让插件在 junction 装载下解析不到宿主包（见文件头注释）。
 * @param ctx - Cordis 上下文（可为 undefined）。
 * @returns 主目录绝对路径。
 */
export function resolveDshHome(ctx) {
  let provided
  try {
    provided = typeof ctx?.get === 'function' ? ctx.get('dshHomePath') : undefined
  } catch {
    provided = undefined // 取服务失败不该让插件装载失败
  }
  if (typeof provided === 'function') {
    // dshHomePath(...segments) 拼在解析出的主目录下；这里只要根。
    const root = provided()
    if (typeof root === 'string' && root.length > 0) return root
  }
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * 解析台账绝对路径。
 * @param config - 已归一化配置。
 * @param ctx - Cordis 上下文（可为 undefined）。
 * @returns 绝对路径。
 */
export function resolveLedgerPath(config, ctx) {
  if (config.ledgerPath.length > 0) return config.ledgerPath
  return join(resolveDshHome(ctx), 'workspace-archive', config.ledgerFile)
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
 * 组装可测引擎：probe（读注册表 + 判存在）→ policy（决策）→ 执行（官方 API），
 * 外加两条**事件驱动**入口：注册表变更事件与目录 watcher，都汇到 `notifyChange()`。
 *
 * @param deps - 依赖注入，全部可替换（`watch`/`now`/`changeDelayMs` 便于测试）。
 * @returns `{ tick, notifyChange, dispose }`。
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
  const watchImpl = deps.watch ?? fsWatch
  const nowImpl = deps.now ?? (() => Date.now())
  /** 事件合并窗口：同一瞬间的多个 fs 事件只跑一轮对账。 */
  const changeDelayMs = deps.changeDelayMs ?? 25
  /** 确认窗口到点后的跟进对账用（测试可注入假定时器）。 */
  const timers = deps.timers ?? { setTimeout, clearTimeout }
  let probeState = createProbeState()
  /**
   * 本进程里是否见过非空注册表。用来挡启动瞬态：注册表 bootstrap 未完成时
   * `list()` 可能是空的，若据此判定"项目被移除"会误归档，所以没见过非空就一律不动。
   */
  let registryWasPopulated = false
  /**
   * 本进程**亲眼见过**出现在 `registry.list()` 里的路径（归一化键）。
   *
   * 用来把两种"不在注册表里"区分开：
   *  - 用户删掉了这条登记（本进程见过它 → 权威动作 → **立即归档**，不等确认窗口）；
   *  - 刚启动、注册表还没 bootstrap 完（本进程从没见过它 → 必须走确认窗口，否则会误归档）。
   * 见 `src/policy.js` 的确认模型说明。
   */
  const seenRegistered = new Set()
  /** parentDir → fs.FSWatcher。 */
  const watchers = new Map()
  let pendingTick = null
  let confirmTimer = null
  let disposed = false

  /**
   * 读一次全量观察：注册表里的工作区 + 台账里独有的路径。
   *
   * 台账独有路径 = **项目登记已从 DSH 移除**（`删除工作区` 菜单，文件夹通常还在）。
   * 用户 2026-10-02 确认：这也算"消失"，要归档；同一目录再次被添加时恢复。
   * @returns observations 数组。
   */
  async function observe() {
    const observations = []
    const seen = new Set()
    const workspaces = registry.list()
    if (workspaces.length > 0) registryWasPopulated = true
    for (const workspace of workspaces) {
      // 见过就算数：`status()` 只说明目录在不在，不说明登记还在不在。
      seenRegistered.add(pathKey(workspace.path))
      const exists = (await workspace.status()) === 'ok'
      observations.push({
        path: workspace.path,
        title: workspace.title,
        // 官方记录 id：policy 靠它识别"记录被删掉后重建"（= 一次消失）。
        workspaceId: workspace.id,
        sessionIds: [...workspace.sessionIds],
        exists,
        reason: exists ? 'ok' : 'folder-missing',
        // 官方实体本身：恢复时用它把会话挂回工作区（`attachSession`）。
        workspace
      })
      seen.add(workspace.path.toLowerCase())
    }
    for (const entry of ledger.entries()) {
      if (seen.has(entry.path.toLowerCase())) continue
      const folderExists = await statDirectory(entry.path)
      observations.push({
        path: entry.path,
        title: entry.title,
        sessionIds: [...(entry.sessionIds ?? [])],
        // 登记没了就算消失（文件夹在不在都一样）；注册表还没见过非空时先按"存在"处理。
        exists: registryWasPopulated === false,
        reason: registryWasPopulated ? 'unregistered' : 'registry-not-ready',
        folderExists
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
    const why = action.reason === 'unregistered' ? '项目已从 DSH 移除' : '目录缺失'

    ledger.recordArchived(action.path, mine)
    if (config.dryRun) {
      logger?.info?.(`workspace-archive[dryRun]: 将归档 ${mine.length} 个会话 @ ${action.path}（${why}）`)
      return
    }
    await ledger.save()
    for (const sessionId of mine) {
      try {
        await registry.archiveSession(sessionId)
        logger?.info?.(`workspace-archive: 已归档 ${sessionId}（${action.path} ${why}）`)
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
   * 恢复一批会话：只处理台账交集（取消归档）。挂回工作区分组是另一件事，见 `attachRestored`。
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
    if (restored.length === 0) return
    ledger.recordRestored(action.path, restored)
    await ledger.save()
  }

  /**
   * 把台账记过的成员挂回工作区（`Workspace.attachSession`）——**只恢复分组，不改归档状态**。
   *
   * 为什么必须有这一步：官方「归档」**不拆** `sessionIds` 槽位，所以"登记还在、目录一度缺失"
   * 的场景下取消归档就等于回到原位；但菜单里的「删除工作区 → 重新添加同一目录」会**新建一个
   * 空成员的项目**（官方语义，旧会话不会自动回来），于是所有成员都散成「无项目」。
   *
   * 名单是**台账快照里所有缺席的成员**，不只是本插件归档过的那批 —— 会话在消失**之前就已经
   * 归档**（典型是用户自己手动归档的）同样会丢槽位，它也该回到自己的分组里；但它**必须保持
   * 归档状态**（这里只调 `attachSession`，绝不碰 `archivedSessionIds`）。
   *
   * 触发条件由 policy 把住：只有"这个工作区经历过一次消失"（台账记着 `missingSince`，或官方
   * 记录被删掉后重建 = id 变了）才会下发本动作 —— 平时绝不重挂，否则会把用户手动移出工作区的
   * 会话又塞回去。
   *
   * `attachSession` 自带 `cwd === 工作区路径` 校验：目录被改名等对不上的情形会抛错，
   * 这里只记日志、继续处理其余会话，绝不猜路径、也不强塞。
   * 它是**前插**（新成员排最前），所以按倒序挂回，恢复后的相对顺序才与原来的成员表一致。
   *
   * @param action - policy 给出的 attach 动作（`sessionIds` = 台账快照里缺席的成员）。
   * @param workspace - 官方工作区实体；缺失或没有该方法时跳过（例如登记尚未回来）。
   * @param sessionIds - 要挂回的会话 id（按原相对顺序）。
   */
  async function attachRestored(action, workspace, sessionIds) {
    if (workspace === undefined || typeof workspace.attachSession !== 'function') return
    const members = new Set(workspace.sessionIds ?? [])
    const missing = sessionIds.filter((sessionId) => members.has(sessionId) === false)
    for (const sessionId of [...missing].reverse()) {
      try {
        await workspace.attachSession(sessionId)
        logger?.info?.(`workspace-archive: 已挂回工作区 ${sessionId}（${action.path}）`)
      } catch (error) {
        logger?.warn?.(`workspace-archive: 挂回 ${sessionId} 失败（${action.path}）：${String(error)}`)
      }
    }
  }

  /**
   * 让 watcher 集合与"当前跟踪的路径"一致：每个工作区目录的**父目录**挂一个非递归 watcher，
   * 目录被删/改名/重建时立刻收到事件。宿主对"目录消失"没有任何事件，这是唯一的事件源。
   * 失效（网络盘、句柄上限、watcher error）只记日志并退回兜底轮询，绝不让插件失败。
   * @param paths - 当前跟踪的工作区路径。
   */
  function reconcileWatchers(paths) {
    if (config.watch === false || disposed) return
    const wanted = new Map()
    for (const path of paths) {
      const parent = dirname(path)
      const name = basename(path).toLowerCase()
      if (!wanted.has(parent)) wanted.set(parent, new Set())
      wanted.get(parent).add(name)
    }
    for (const [parent, watcher] of watchers) {
      if (wanted.has(parent)) continue
      try {
        watcher.close()
      } catch { /* 关闭失败无所谓 */ }
      watchers.delete(parent)
    }
    for (const [parent, names] of wanted) {
      if (watchers.has(parent)) continue
      try {
        const watcher = watchImpl(parent, { persistent: false }, (_eventType, filename) => {
          // filename 为空时（部分平台/网络盘）保守地当作相关变化处理。
          const changed = typeof filename === 'string' ? filename.toLowerCase() : undefined
          if (changed === undefined || names.has(changed)) notifyChange()
        })
        watcher.on?.('error', (error) => {
          logger?.warn?.(`workspace-archive: 目录监听失效，退回兜底轮询（${parent}）：${String(error)}`)
          try {
            watcher.close()
          } catch { /* 已经坏了 */ }
          watchers.delete(parent)
        })
        watchers.set(parent, watcher)
      } catch (error) {
        logger?.warn?.(`workspace-archive: 无法监听 ${parent}，退回兜底轮询：${String(error)}`)
      }
    }
  }

  /** 关掉所有 watcher 与跟进定时器（插件卸载时）。 */
  function dispose() {
    disposed = true
    if (confirmTimer !== null) {
      timers.clearTimeout(confirmTimer)
      confirmTimer = null
    }
    for (const watcher of watchers.values()) {
      try {
        watcher.close()
      } catch { /* 已经坏了 */ }
    }
    watchers.clear()
  }

  /**
   * 确认窗口的跟进对账：事件只来一次，所以"开始计时"之后必须在窗口到点时再对账一次，
   * 否则要等到兜底轮询（分钟级）才会真正归档。
   */
  function scheduleConfirm() {
    if (disposed) return
    const pending = probeState.missingSince.size > 0
    if (pending && confirmTimer === null) {
      confirmTimer = timers.setTimeout(() => {
        confirmTimer = null
        notifyChange()
      }, Math.max(config.confirmDelayMs ?? 0, 0) + 50)
      confirmTimer?.unref?.()
    } else if (pending === false && confirmTimer !== null) {
      timers.clearTimeout(confirmTimer)
      confirmTimer = null
    }
  }

  /**
   * 事件入口：注册表变更事件与 watcher 事件都走这里，合并成一轮对账。
   * @returns 本轮对账的 promise。
   */
  function notifyChange() {
    if (disposed) return Promise.resolve([])
    if (pendingTick !== null) return pendingTick
    pendingTick = new Promise((resolve) => setTimeout(resolve, changeDelayMs))
      .then(() => {
        pendingTick = null
        return tick()
      })
      .catch((error) => {
        pendingTick = null
        logger?.warn?.(`workspace-archive: 变更触发的对账失败：${String(error)}`)
        return []
      })
    return pendingTick
  }

  /** 跑一轮对账。 */
  async function tick() {
    const observations = await observe()
    const { actions, state } = evaluate({
      observations,
      state: probeState,
      confirmDelayMs: config.confirmDelayMs,
      now: nowImpl(),
      ledger,
      // 官方归档集合的当前快照：用来区分「用户手动归档」和「本插件归档」。
      alreadyArchived: new Set(registry.archivedSessionIds ?? []),
      // 本进程见过这条登记 ⇒ 它的消失是权威事件，不等确认窗口（见 policy.js 的确认模型）。
      wasRegistered: (path) => seenRegistered.has(pathKey(path))
    })
    probeState = state
    // 恢复/挂回都要用官方实体，所以先把这一轮看到的实体按路径索引好。
    const workspacesByPath = new Map()
    for (const observation of observations) {
      if (observation.workspace !== undefined) {
        workspacesByPath.set(pathKey(observation.path), observation.workspace)
      }
    }
    for (const action of actions) {
      if (action.kind === 'archive') await runArchive(action)
      else if (action.kind === 'unarchive') await runUnarchive(action)
      else if (action.kind === 'attach') {
        await attachRestored(action, workspacesByPath.get(pathKey(action.path)), action.sessionIds)
      }
    }
    // 健康视图也要落盘：这就是「抢在官方 prune 之前」的那份记录。
    if (!config.dryRun && actions.every((action) => action.kind !== 'archive')) await ledger.save()
    reconcileWatchers(observations.map((observation) => observation.path))
    scheduleConfirm()
    return actions
  }

  return { tick, notifyChange, dispose }
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
  let timer
  try {
    timer = typeof ctx?.get === 'function' ? ctx.get('timer') : undefined
  } catch {
    timer = undefined // 没有 timer 服务就退化，绝不让装载失败
  }
  if (typeof timer?.interval === 'function') return timer.interval(run, intervalMs)
  const handle = setInterval(run, intervalMs)
  if (typeof ctx?.on === 'function') ctx.on('dispose', () => clearInterval(handle))
  return handle
}

/**
 * 装载插件：载入台账、立即对账一次，然后**事件驱动**（注册表变更事件 + 目录 watcher），
 * 外加一个低频兜底轮询防漏。
 * @param ctx - Cordis 上下文（需要 `workspaceRegistry`；`logger`、`timer` 可选）。
 * @param config - 行配置。
 * @returns 引擎句柄（便于测试与手动触发 tick）。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const registry = ctx?.workspaceRegistry
  if (registry === undefined) throw new Error('workspace-archive: 缺少 workspaceRegistry 服务')

  const ledger = new LedgerStore(resolveLedgerPath(resolved, ctx))
  const engine = createEngine({ registry, ledger, config: resolved, logger: ctx?.logger })

  const run = () => {
    engine.tick().catch((error) => ctx?.logger?.warn?.(`workspace-archive: 对账失败 ${String(error)}`))
  }

  ledger.load().then(run, run)

  // 事件源①：官方 storage 领域变更（新增/删除项目、排序、归档集合…）→ 秒级反应。
  // 注册在插件自己的 fiber 作用域里，插件卸载时 Cordis 会一并清理。
  if (typeof ctx?.on === 'function') {
    ctx.on('domain/changed', () => engine.notifyChange())
  }
  // 事件源②：目录 watcher 在 tick 里按当前路径集合维护（reconcileWatchers）。

  // 兜底：低频全量对账，防 watcher / 事件漏报。
  scheduleInterval(ctx, run, resolved.pollIntervalMs)

  /**
   * 「无项目 → 按 cwd 归位」（T0）：**启动后只跑一次**。
   * `sessionPersistence` 是可选依赖（只读 `list()` 拿 header）；拿不到就什么都不做。
   * 归位只调官方 `Workspace.attachSession`，失败逐条记日志。
   */
  let adopt = () => Promise.resolve([])
  if (resolved.adoptUngrouped) {
    const arm = (scope) => {
      const persistence = typeof scope?.get === 'function' ? scope.get('sessionPersistence') : undefined
      if (persistence === undefined) return
      adopt = () => adoptUngrouped({ registry, persistence, logger: ctx?.logger, dryRun: resolved.dryRun })
      const handle = setTimeout(() => {
        adopt().catch((error) => ctx?.logger?.warn?.(`workspace-archive: 归位失败 ${String(error)}`))
      }, resolved.adoptDelayMs)
      handle?.unref?.()
      if (typeof scope?.on === 'function') scope.on('dispose', () => clearTimeout(handle))
    }
    if (typeof ctx?.inject === 'function') ctx.inject(['sessionPersistence'], arm)
    else arm(ctx)
  }

  // 卸载时关掉 watcher。
  if (typeof ctx?.effect === 'function') ctx.effect(() => () => engine.dispose(), 'workspace-archive.watchers')
  else if (typeof ctx?.on === 'function') ctx.on('dispose', () => engine.dispose())

  ctx?.logger?.info?.(
    'workspace-archive: 已装载（事件驱动 + 兜底轮询）'
      + ` confirmDelayMs=${resolved.confirmDelayMs}`
      + ` watch=${resolved.watch}`
      + ` adoptUngrouped=${resolved.adoptUngrouped}`
      + ` backstopPollMs=${resolved.pollIntervalMs}`
      + ` dryRun=${resolved.dryRun}`
      + ` ledger=${ledger.file}`
  )

  return { engine, ledger, adopt }
}
