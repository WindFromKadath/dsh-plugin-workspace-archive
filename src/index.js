/**
 * dsh-plugin-workspace-archive — DSH 宿主侧插件。
 *
 * 需求②：工作区目录被删除/移走后，把它下面**由本插件登记过的**会话归档；
 * 同一个目录回来后，**只**恢复这批会话，绝不碰用户自己手动归档的会话。
 *
 * 四层结构（各自可单独测试）：
 *   - `src/ledger.js`  sidecar 台账：路径 → 会话 id，先落盘再动官方归档；
 *   - `src/policy.js`  纯决策：去抖后决定这一轮归档谁、恢复谁（**目录消失的自动路径**）；
 *   - `src/manual.js`  纯决策：**手动**归档/恢复一个工作区（F020，模型可见工具 `workspace_archive`）；
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

import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { adoptUngrouped } from './adopt.js'
import { LedgerStore, pathKey } from './ledger.js'
import { planManual, resolveWorkspace } from './manual.js'
import { parseMigrationIntent, planMigrationStep } from './migrate.js'
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
    /**
     * 是否处理离线迁移工具留下的**意图**（`offline/apply.js` 写的 `pending-migrations.json`）：
     * 把迁移过来的会话用官方 `attachSession` 挂到新路径的工作区。可关。
     * 归档态不用补偿 —— 官方归档集合是会话 id 的全局集合，与 cwd 无关。
     */
    applyMigrations: raw.applyMigrations ?? true,
    /**
     * 意图文件路径。**空 = 由 DSH 主目录推导**（`$DSH_HOME/workspace-archive/pending-migrations.json`）。
     * 文件**存在**即触发；处理完会改名成 `consumed-migrations-<时间戳>.json` 留痕。
     */
    migrationIntentPath: raw.migrationIntentPath ?? '',
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
  if (typeof resolved.applyMigrations !== 'boolean') {
    throw new TypeError('workspace-archive config applyMigrations must be a boolean')
  }
  if (typeof resolved.migrationIntentPath !== 'string') {
    throw new TypeError('workspace-archive config migrationIntentPath must be a string (empty = derive from DSH home)')
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
 * 解析迁移意图文件的绝对路径。默认与台账同目录（`$DSH_HOME/workspace-archive/`）。
 * @param config - 已归一化配置。
 * @param ctx - Cordis 上下文（可为 undefined）。
 * @returns 绝对路径。
 */
export function resolveMigrationIntentPath(config, ctx) {
  if (config.migrationIntentPath.length > 0) return config.migrationIntentPath
  return join(resolveDshHome(ctx), 'workspace-archive', 'pending-migrations.json')
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
  /**
   * parentDir → `{ names, paths }`：该父目录下被跟踪的名字（小写 basename）与**完整路径**。
   *
   * ⚠️ 每次 reconcile 都**整体替换**这一项，而 watcher 闭包**每次事件都重新从 map 里取** ——
   * 所以后来新增/换名的工作区立刻生效（旧实现把名字集合快照捕进闭包，永远只有建立时那批，见 F023）。
   */
  const watched = new Map()
  let probeTimer = null
  /** 「迁移意图还在等目标工作区登记」这类日志只打一次，免得每个 tick 刷屏。 */
  let migrationPendingLogged = false
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
   * **手动**归档 / 恢复一个工作区（F020）。
   *
   * 与自动路径完全分开：只碰台账的 `manualArchivedSessionIds`，**绝不碰** `archivedSessionIds`
   * —— 所以"目录消失又回来"的自动恢复不会撤销用户的手动归档，反之亦然。
   *
   * 解析不唯一时**拒绝并列候选**，不猜。`dryRun` 下只记日志。
   * @param options - `query`（工作区路径或标题）/ `action`（`'archive'` | `'unarchive'`）。
   * @returns 结果对象；`ok: false` 时带 `reason`（与工具 `output.schema` **逐字段一致**）。
   */
  async function manualWorkspace(options) {
    const action = options?.action === 'unarchive' ? 'unarchive' : 'archive'
    const entityList = registry.list()
    const projection = entityList.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds]
    }))
    const resolved = resolveWorkspace(projection, options?.query)
    if (resolved.ok !== true) return resolved

    const workspace = resolved.workspace
    // 手动动作的入口：先把这条工作区的健康视图刷进台账（恢复要靠它）。
    ledger.syncHealthy(workspace.path, workspace.title, workspace.sessionIds, workspace.id)
    const entry = ledger.entry(workspace.path)
    const plan = planManual({
      workspace,
      alreadyArchived: new Set(registry.archivedSessionIds ?? []),
      entry,
      action
    })

    const base = {
      ok: true,
      kind: plan.kind,
      path: workspace.path,
      title: workspace.title,
      requested: plan.sessionIds.length,
      skipped: plan.skipped.length,
      dryRun: config.dryRun === true
    }
    if (config.dryRun === true) {
      logger?.info?.(
        `workspace-archive[dryRun]: 将手动${plan.kind === 'archive' ? '归档' : '恢复'} `
        + `${plan.sessionIds.length} 个会话 @ ${workspace.path}`
      )
      return { ...base, applied: 0, sessionIds: [] }
    }

    const applied = []
    if (plan.kind === 'archive') {
      if (plan.sessionIds.length === 0) {
        await ledger.save()
        return { ...base, applied: 0, sessionIds: [] }
      }
      // 沿用硬约束：先落台账，再动官方（id 会被下一次 workspace 写操作永久 prune）。
      ledger.recordManualArchived(workspace.path, plan.sessionIds)
      await ledger.save()
      for (const sessionId of plan.sessionIds) {
        try {
          await registry.archiveSession(sessionId)
          applied.push(sessionId)
          logger?.info?.(`workspace-archive: 手动归档 ${sessionId}（${workspace.path}）`)
        } catch (error) {
          if (isActiveSessionRefusal(error)) {
            // 会话还在跑：跳过，绝不强停用户正在进行的工作。
            logger?.warn?.(`workspace-archive: 跳过仍在运行的 ${sessionId}（${workspace.path}）`)
            continue
          }
          logger?.warn?.(`workspace-archive: 手动归档 ${sessionId} 失败：${String(error)}`)
        }
      }
      return { ...base, applied: applied.length, sessionIds: applied }
    }

    // 恢复：先解归档，再按**实际成功**的改台账（失败的留着重试）。
    for (const sessionId of plan.sessionIds) {
      try {
        await registry.unarchiveSession(sessionId)
        applied.push(sessionId)
        logger?.info?.(`workspace-archive: 手动恢复 ${sessionId}（${workspace.path}）`)
      } catch (error) {
        logger?.warn?.(`workspace-archive: 手动恢复 ${sessionId} 失败：${String(error)}`)
      }
    }
    if (applied.length > 0) {
      ledger.recordManualRestored(workspace.path, applied)
      await ledger.save()
    }
    return { ...base, applied: applied.length, sessionIds: applied }
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
      if (!wanted.has(parent)) wanted.set(parent, { names: new Set(), paths: new Set() })
      wanted.get(parent).names.add(name)
      wanted.get(parent).paths.add(path)
    }
    for (const [parent, watcher] of [...watchers]) {
      if (wanted.has(parent)) continue
      try {
        watcher.close()
      } catch { /* 关闭失败无所谓 */ }
      watchers.delete(parent)
      watched.delete(parent)
    }
    // ② **已监听的父目录也要刷新**名字簿。旧实现这里直接 `continue`，于是闭包永远拿着
    //    "建立 watcher 那一刻"的快照 —— 之后新增/换名的同一父目录下工作区，按名字再也命中不了。
    //    watcher 闭包每次事件都重新从 `watched` 取，所以整体替换是安全的，不必重建 watcher。
    for (const [parent, state] of wanted) watched.set(parent, state)
    // ③ 给还没监听的父目录建 watcher
    for (const parent of wanted.keys()) {
      if (watchers.has(parent)) continue
      try {
        const watcher = watchImpl(parent, { persistent: false }, (_eventType, filename) => {
          const live = watched.get(parent)
          if (live === undefined) return
          // filename 为空时（部分平台/网络盘）保守地当作相关变化处理。
          const changed = typeof filename === 'string' ? filename.toLowerCase() : undefined
          if (changed === undefined || live.names.has(changed)) {
            void notifyChange()
            return
          }
          // ⚠️ 未知 filename（F023）：**改文件夹名**时 `fs.watch` 给的是**新名字**，不在被跟踪的
          // 名字集合里；旧实现直接丢弃 ⇒ 插件不被叫醒 ⇒ 要等兜底轮询（默认 5 分钟）才归档，
          // 与"删目录"（filename 恰是旧名字、立刻归档）行为不一致。
          schedulePresenceProbe()
        })
        watcher.on?.('error', (error) => {
          logger?.warn?.(`workspace-archive: 目录监听失效，退回兜底轮询（${parent}）：${String(error)}`)
          try {
            watcher.close()
          } catch { /* 已经坏了 */ }
          watchers.delete(parent)
          watched.delete(parent)
        })
        watchers.set(parent, watcher)
      } catch (error) {
        logger?.warn?.(`workspace-archive: 无法监听 ${parent}，退回兜底轮询：${String(error)}`)
      }
    }
  }

  /**
   * 未知 filename 的合并存活探测（F023）。
   *
   * 语义：这个父目录里有个"我不认识的名字"动了 —— 那会不会是**我跟踪的某个目录被改名走了**？
   * 只对"该父目录下被跟踪的 path"各做一次 `statDirectory`：**不触发对账、不写盘**，
   * 所以父目录里出现无关条目时的代价是一次 stat，而不是一轮对账 + 一次台账落盘。
   */
  function schedulePresenceProbe() {
    if (disposed || probeTimer !== null) return
    probeTimer = timers.setTimeout(() => {
      probeTimer = null
      void probeTrackedPresence()
    }, changeDelayMs)
    probeTimer?.unref?.()
  }

  /** 逐条探测被跟踪的 path；只要有一条已经不在了就唤醒对账（走正常的确认窗口）。 */
  async function probeTrackedPresence() {
    if (disposed) return
    for (const state of watched.values()) {
      for (const path of state.paths) {
        if ((await statDirectory(path)) === false) {
          void notifyChange()
          return
        }
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
    if (probeTimer !== null) {
      timers.clearTimeout(probeTimer)
      probeTimer = null
    }
    for (const watcher of watchers.values()) {
      try {
        watcher.close()
      } catch { /* 已经坏了 */ }
    }
    watchers.clear()
    watched.clear()
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
  /**
   * 消费离线迁移工具留下的**意图**（F022 的在线层）。
   *
   * 离线层负责改不了官方 API 的那半（改写 header 的 cwd、搬日志目录）；这一层只做官方 API 能做的：
   * 把会话 `attachSession` 到新路径的工作区，并尽力从旧工作区 `detachSession`。
   *
   * **归档态不用补偿**：官方归档集合是**会话 id 的全局集合**，与 cwd、与工作区都无关
   * ⇒ 原本归档的会话在新组里**仍然归档**。
   *
   * 幂等、可重入：文件**存在**即触发（每个 tick 看一眼 `existsSync`，很便宜）；处理完写一份
   * `consumed-migrations-<时间戳>.json` 留痕再删掉待处理文件。坏文件改名成 `invalid-…` 留痕，
   * 免得每轮重试。目标工作区还没登记时**保持待处理**（用户可能马上就把那个目录加进来）。
   * @returns 结果对象，或 `null`（没开 / 没有意图）。
   */
  async function runMigrations() {
    // 默认**开**：`resolveConfig` 会给默认值，但引擎也可能被直接喂原始 config（测试就是这么用的），
    // 所以这里只认显式的 `false` 才关闭 —— 免得"少了一个字段"静默变成"功能没跑"。
    if (config.applyMigrations === false) return null
    const path = config.migrationIntentPath
    if (typeof path !== 'string' || path.length === 0) return null
    if (existsSync(path) === false) return null

    const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
    let parsed
    try {
      parsed = parseMigrationIntent(await readFile(path, 'utf8'))
    } catch (error) {
      parsed = { ok: false, reason: `intent-unreadable: ${String(error)}` }
    }
    if (parsed.ok !== true) {
      try {
        await rename(path, join(dirname(path), `invalid-migrations-${stamp()}.json`))
      } catch { /* 移不动就留着，下一轮再说 */ }
      logger?.warn?.(`workspace-archive: 迁移意图不可用，已移到一边：${parsed.reason}`)
      return { ok: false, reason: parsed.reason }
    }

    const intent = parsed.intent
    const entities = registry.list()
    const projection = entities.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      sessionIds: [...workspace.sessionIds]
    }))
    const step = planMigrationStep(intent, projection)
    if (step.ok !== true) {
      if (migrationPendingLogged === false) {
        migrationPendingLogged = true
        logger?.warn?.(`workspace-archive: 迁移意图还在等目标工作区登记：${step.reason}`)
      }
      return { ok: false, reason: step.reason }
    }
    migrationPendingLogged = false

    if (config.dryRun === true) {
      logger?.info?.(
        `workspace-archive[dryRun]: 迁移意图待处理 ${intent.sessions.length} 条`
        + `（挂回 ${step.attach.length} / 摘掉 ${step.detach.length}）`
      )
      return { ok: true, dryRun: true, attach: step.attach.length, detach: step.detach.length }
    }

    const attached = []
    const detached = []
    // 失败也要进审计记录 —— 只写日志的话，装置/用户都看不到到底哪条没挂上、为什么。
    const failures = []
    const target = entities.find((workspace) => workspace.id === step.target.id)
    for (const sessionId of step.attach) {
      try {
        await target.attachSession(sessionId)
        attached.push(sessionId)
      } catch (error) {
        failures.push({ sessionId, phase: 'attach', error: String(error) })
        logger?.warn?.(`workspace-archive: 迁移后挂回 ${sessionId} 失败：${String(error)}`)
      }
    }
    const source = step.source === null ? undefined : entities.find((workspace) => workspace.id === step.source.id)
    for (const sessionId of step.detach) {
      try {
        await source.detachSession(sessionId)
        detached.push(sessionId)
      } catch (error) {
        failures.push({ sessionId, phase: 'detach', error: String(error) })
        logger?.warn?.(`workspace-archive: 从旧工作区摘掉 ${sessionId} 失败：${String(error)}`)
      }
    }

    const record = {
      consumedAt: new Date().toISOString(),
      intent,
      attached,
      detached,
      failures,
      targetPath: step.target.path,
      sourcePath: step.source === null ? null : step.source.path
    }

    // ⚠️ **有失败就不要消费意图。** 最常见的原因是：离线改写是在**本进程还活着的时候**做的 ——
    // 官方 registry 有 header 内存缓存（`dsh-workspace/lib/index.js:911-923` 的 `this.headers`），
    // 它会一直吐出**旧的** cwd，于是 `attachSession` 报 "its cwd resolves to <旧路径>"。
    // 那种情况下唯一的解法是**重启 DSH**；把意图留着，下次启动就会成功。
    if (failures.length > 0) {
      try {
        await writeFile(
          join(dirname(path), `migration-failures-${stamp()}.json`),
          JSON.stringify(record, null, 2),
          'utf8'
        )
      } catch { /* 留痕失败不影响主流程 */ }
      if (migrationPendingLogged === false) {
        migrationPendingLogged = true
        logger?.warn?.(
          `workspace-archive: 迁移意图处理有 ${failures.length} 条失败，**保持待处理**`
          + '（多半是离线改写与本次启动之间有重叠 —— 重启 DSH 后会成功）'
        )
      }
      return { ok: false, reason: 'attach-failed', failures, attach: attached.length, detach: detached.length }
    }

    try {
      await writeFile(join(dirname(path), `consumed-migrations-${stamp()}.json`), JSON.stringify(record, null, 2), 'utf8')
      await rm(path, { force: true })
    } catch (error) {
      logger?.warn?.(`workspace-archive: 迁移意图留痕失败（意图会再跑一次，幂等）：${String(error)}`)
    }
    logger?.info?.(
      `workspace-archive: 迁移意图已处理（挂回 ${attached.length} / 摘掉 ${detached.length}）`
      + ` → ${step.target.path}`
    )
    return { ok: true, attach: attached.length, detach: detached.length }
  }

  async function tick() {
    // 先把离线迁移的意图消化掉，再对账 —— 这样这一轮的观察就已经是"迁移之后"的状态。
    await runMigrations()
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

  return { tick, notifyChange, manualWorkspace, runMigrations, dispose }
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
 * 构造「手动归档一个工作区」的 `ToolDefinition`（F020）。
 *
 * **为什么手写而不是 import `defineTool`**：本插件的零运行时依赖是硬约束（D009）——junction 装载下
 * 解析宿主包会 `ERR_MODULE_NOT_FOUND`，插件直接装载失败。而 `ToolSchema.parameters` 本来就是
 * **普通 JSON Schema**（`dsh-llm` 的 `ToolSchema.parameters: Record<string, unknown>`），
 * `output.render` 只要返回 `[{ type: 'text', text }]`，所以整份定义可以零 import 手写。
 *
 * ⚠️ `output.schema` 是**硬校验**：`execute` 多返回一个未声明字段，整次调用就会变成
 * `returned invalid output`（`dsh-plugin-branch` V21 踩过）⇒ **加返回字段必须同时改这里**。
 *
 * @param engine - `createEngine()` 的返回值（要用它的 `manualWorkspace`）。
 * @returns 可直接交给 `ctx.tools.register()` 的定义。
 */
export function defineManualTool(engine) {
  return {
    name: 'workspace_archive',
    description:
      '手动归档一个工作区：把它名下**官方尚未归档**的会话收进归档（默认），'
      + "或用 action='unarchive' 恢复此前由本工具归档的那些。"
      + '只处理该工作区成员表里的会话；用户自己在官方界面里归档的会话永不被触碰。'
      + '归档只是隐藏、不删任何数据，随时可用 action=\'unarchive\' 放回。',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: '工作区路径（精确匹配，优先）或它的显示标题'
        },
        action: {
          type: 'string',
          description: "archive（默认）= 归档；unarchive = 恢复本工具此前归档的那些"
        }
      },
      required: ['workspace'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          kind: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          requested: { type: 'number' },
          skipped: { type: 'number' },
          applied: { type: 'number' },
          dryRun: { type: 'boolean' },
          sessionIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, title: { type: 'string' } },
              required: ['path', 'title'],
              additionalProperties: false
            }
          }
        },
        required: ['ok'],
        additionalProperties: false
      },
      render: (_args, value) => [{ type: 'text', text: renderManualResult(value) }]
    },
    execute: async (args) => engine.manualWorkspace({
      query: args?.workspace,
      action: args?.action
    })
  }
}

/**
 * 把 `manualWorkspace` 的结果渲染成模型可读的一段话。纯函数。
 * @param value - `manualWorkspace` 的返回值。
 * @returns 文本。
 */
export function renderManualResult(value) {
  if (value?.ok === false) {
    if (value.reason === 'ambiguous') {
      const lines = (value.candidates ?? []).map((c) => `- ${c.path}（${c.title}）`)
      return `解析到多个工作区，请给出更精确的路径：\n${lines.join('\n')}`
    }
    if (value.reason === 'empty-query') return '没有给出工作区：请传路径或标题。'
    return '没有找到匹配的工作区（路径需精确匹配，可用显示标题）。'
  }
  const doing = value?.kind === 'unarchive' ? '恢复' : '归档'
  const head = `${doing}「${value?.title}」(${value?.path})：`
  if (value?.dryRun === true) return `${head}dryRun 模式下仅演练 —— 计划处理 ${value?.requested} 个会话，未改动任何数据。`
  if ((value?.requested ?? 0) === 0) {
    const why = value?.kind === 'unarchive' ? '没有由本工具归档过的会话' : '没有需要归档的会话（可能都已在归档里）'
    return `${head}${why}。`
  }
  const skipped = value?.skipped > 0 ? `，跳过 ${value.skipped} 个（已在官方归档集合里，不由本工具接管）` : ''
  return `${head}已${doing} ${value?.applied}/${value?.requested} 个会话${skipped}。`
}

/**
 * 本插件注册的斜杠命令（F021）。
 *
 * 与模型可见工具 `workspace_archive` **共用同一个引擎函数**：命令只是"由人触发"的第二个入口，
 * **不复制任何归档/恢复逻辑**（台账分账、dryRun、解析不唯一即拒绝、绝不碰用户手动归档的会话，
 * 全部由 `engine.manualWorkspace` 继承）。命令本身会写进会话日志（`command/run` / `command/done`），
 * 所以"谁在什么时候归档了哪个工作区"是可审计的。
 */
export const COMMANDS = [
  {
    name: 'archive-workspace',
    action: 'archive',
    description: '归档一个工作区的全部对话（只处理官方尚未归档的；你自己归档的不动）'
  },
  {
    name: 'restore-workspace',
    action: 'unarchive',
    description: '放回此前由本插件归档的那个工作区的对话'
  }
]

/**
 * 把命令注册进宿主的命令注册表（`ctx.commands`）。
 *
 * **逐条 try/catch**：一条注册失败不影响另一条，也绝不拖垮插件（与工具注册同一套 fail-safe）。
 * 纯宿主侧，不需要客户端半边 —— 命令的发现与渲染由官方的 `dsh-client-ui-commands` 负责。
 *
 * @param runtime - `ctx.commands`（或测试替身）。
 * @param engine - `createEngine()` 的返回值。
 * @param logger - 可选日志。
 * @returns 实际注册成功的命令名数组（便于真机断言）。
 */
export function registerCommands(runtime, engine, logger) {
  const done = []
  if (runtime === undefined || typeof runtime.register !== 'function') return done
  for (const spec of COMMANDS) {
    try {
      runtime.register({
        name: spec.name,
        description: spec.description,
        input: { hint: '工作区路径或显示标题' },
        handler: async (invocation) => {
          const value = await engine.manualWorkspace({
            query: invocation?.rawInput,
            action: spec.action
          })
          if (value?.ok === false) return { kind: 'error', text: renderManualResult(value) }
          return { kind: 'success', text: renderManualResult(value) }
        }
      })
      done.push(spec.name)
    } catch (error) {
      logger?.warn?.(`workspace-archive: 命令 /${spec.name} 注册失败：${String(error)}`)
    }
  }
  return done
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
  /**
   * 宿主日志器。**必须在这里取成局部变量**：`armTools` / `armCommands` 的 catch 里要用它 ——
   * 之前直接写裸 `logger` 会抛 `ReferenceError`，而那个错恰好被它们自己的 try/catch 吞掉，
   * 表现是"命令静默没注册"（2026-10-11 由真机装置抓到）。
   */
  const logger = ctx?.logger

  const ledger = new LedgerStore(resolveLedgerPath(resolved, ctx))
  // 意图路径要在建引擎**之前**解析成绝对路径 —— 引擎不该知道 DSH 主目录是怎么来的。
  resolved.migrationIntentPath = resolveMigrationIntentPath(resolved, ctx)
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

  /**
   * 「手动归档工作区」的模型可见工具（F020）。
   *
   * `tools` 是**可选**服务：用 `ctx.inject` 等它；缺了就不注册工具，归档/恢复的其余能力照常。
   * 定义是手写的（见 `defineManualTool` 的说明）—— 为了不 import 宿主包、保住零依赖硬约束。
   */
  const armTools = (scope) => {
    const tools = typeof scope?.get === 'function' ? scope.get('tools') : undefined
    if (tools === undefined || typeof tools.register !== 'function') return
    try {
      tools.register(defineManualTool(engine))
    } catch (error) {
      // 工具注册失败**绝不能拖垮插件**：归档/恢复的其余能力与它无关。
      logger?.warn?.(`workspace-archive: workspace_archive 工具注册失败（其余能力不受影响）：${String(error)}`)
    }
  }
  if (typeof ctx?.inject === 'function') ctx.inject(['tools'], armTools)
  else armTools(ctx)

  /**
   * 「手动归档工作区」的**斜杠命令**入口（F021）：`/archive-workspace`、`/restore-workspace`。
   *
   * 同样是**可选**服务；纯宿主侧，不需要客户端半边（发现与渲染由官方 `dsh-client-ui-commands` 负责）。
   */
  const armCommands = (scope) => {
    const commands = typeof scope?.get === 'function' ? scope.get('commands') : undefined
    if (commands === undefined) return
    try {
      const names = registerCommands(commands, engine, logger)
      if (names.length > 0) logger?.info?.(`workspace-archive: 已注册命令 ${names.map((n) => `/${n}`).join(' ')}`)
    } catch (error) {
      // 命令注册失败**绝不能拖垮插件**。
      logger?.warn?.(`workspace-archive: 命令注册失败（其余能力不受影响）：${String(error)}`)
    }
  }
  if (typeof ctx?.inject === 'function') ctx.inject(['tools'], armTools)
  else armTools(ctx)
  if (typeof ctx?.inject === 'function') ctx.inject(['commands'], armCommands)
  else armCommands(ctx)

  // 卸载时关掉 watcher。
  if (typeof ctx?.effect === 'function') ctx.effect(() => () => engine.dispose(), 'workspace-archive.watchers')
  else if (typeof ctx?.on === 'function') ctx.on('dispose', () => engine.dispose())

  logger?.info?.(
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
