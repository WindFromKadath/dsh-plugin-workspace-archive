/**
 * 真机测试：在本工作区内的临时 DSH_HOME 里启动**真的** DSH 运行时
 * （真 Loader / 真 session 持久化 / 真 storage-domain / 真 workspace 注册表），
 * 然后跑完整场景：
 *
 *   建临时工作区 → 建两个真会话（A 交给插件管，B 模拟用户手动归档）
 *   → 删掉工作区目录 → 等插件轮询 → 断言 A 被归档、B 不受影响
 *   → 把目录放回来 → 等插件轮询 → 断言 A 恢复、**B 仍然归档**
 *
 * 全程不碰用户的 `~/.dsh`：DSH_HOME 指向 `.verify/home`，场景目录是 `.verify/proj`。
 *
 * 用法：npm run rm-test   （= node --import ./test/register.mjs .verify/real-machine.mjs）
 */

import { mkdir, readdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const home = join(root, '.verify', 'home')
const configPath = join(root, '.verify', 'rm', 'cordis.yml')
const projectDir = join(root, '.verify', 'proj')
/** T0「无项目 → 按 cwd 归位」的目标工作区（独立于阶段 3–5 用的那个，避免互相干扰）。 */
const adoptDir = join(root, '.verify', 'proj-adopt')
/** T0 的反例目录：它**不是**任何工作区，cwd 指向它的会话必须保持「无项目」。 */
const orphanDir = join(root, '.verify', 'proj-orphan')
const ledgerFile = join(home, 'workspace-archive', 'ledger.json')
const registryFile = join(home, 'storages', 'workspace.json')
const userRegistryFile = join(process.env.USERPROFILE ?? '', '.dsh', 'storages', 'workspace.json')

/**
 * 事件驱动档下的等待时间：watcher / domain 事件 → 合并窗口(25ms) → 首次对账 → 跟进对账(50ms)。
 * 2 秒足够，也留出文件系统事件的余量。
 */
const POLL_WAIT_MS = 2000

const report = { phases: [], checks: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 用户真实注册表里的归档数量：用来证明本次测试没有污染它。 */
async function userArchivedCount() {
  try {
    return (await readJson(userRegistryFile)).global.archivedSessionIds.length
  } catch {
    return null
  }
}

process.env.DSH_HOME = home

// 自链接：Loader 需要按**包名**解析到本仓库（`name: dsh-plugin-workspace-archive`）。
// 目标在工作区内，沙箱允许；已存在就跳过。指向工作区外的 junction 会被沙箱拒绝，所以
// `@deepseek-ai/*` 走 test/register.mjs 的解析钩子，而不是再建一个 junction。
const selfLink = join(root, 'node_modules', 'dsh-plugin-workspace-archive')
if ((await exists(selfLink)) === false) {
  await mkdir(dirname(selfLink), { recursive: true })
  await symlink(root, selfLink, 'junction')
}

// 干净起步
await rm(home, { recursive: true, force: true })
await rm(projectDir, { recursive: true, force: true })
await mkdir(home, { recursive: true })
await mkdir(projectDir, { recursive: true })
await mkdir(adoptDir, { recursive: true })
await mkdir(orphanDir, { recursive: true })

const userArchivedBefore = await userArchivedCount()
console.log(`DSH_HOME = ${home}`)
console.log(`场景目录 = ${projectDir}`)
console.log(`用户真实注册表归档数（测试前）= ${userArchivedBefore}`)

const { boot } = await import('@deepseek-ai/dsh-app-boot')
const ctx = await boot('dsh-rm-test', configPath, [], undefined, pathToFileURL(join(root, 'package.json')).href)

const registry = ctx.get('workspaceRegistry')
const persistence = ctx.get('sessionPersistence')
check('真机装载：workspaceRegistry 服务存在', registry !== undefined)
check('真机装载：sessionPersistence 服务存在', persistence !== undefined)

// 装载自证：apply 之后第一轮对账就会把（当时的空）台账落盘到配置的 ledgerPath。
let mounted = false
for (let i = 0; i < 25 && mounted === false; i++) {
  mounted = await exists(ledgerFile)
  if (mounted === false) await sleep(200)
}
check('真机装载：本插件已装载并自行落盘台账（配置路径生效）', mounted, { ledgerFile })

try {
  // ── 阶段 1：建工作区 + 两个真会话 ───────────────────────────────
  const workspace = await registry.create(projectDir)
  report.phases.push({ phase: 'create-workspace', path: workspace.path, id: workspace.id })

  const sessionA = `session-${randomUUID()}`
  const sessionB = `session-${randomUUID()}`
  for (const id of [sessionA, sessionB]) {
    const handle = await persistence.create({
      version: 4,
      id,
      createdAt: Date.now(),
      cwd: workspace.path,
      isSeeded: false,
      delegationDepth: 0
    })
    await handle.flush()
    await handle.close()
    await workspace.attachSession(id)
  }
  check('真会话已实体化并归属工作区', workspace.sessionIds.length === 2, { sessionIds: workspace.sessionIds })

  // B：模拟「用户自己手动归档」，全程都不该被插件动过
  await registry.archiveSession(sessionB)

  // ── 阶段 1b：为 T0「无项目 → 按 cwd 归位」备料 ────────────────────
  // 第二个工作区 + 两条**未分组**真会话：一条 cwd 命中该工作区路径，一条 cwd 指向
  // 谁都不是的目录。插件启动后只跑一次归位（默认 5 秒后），所以必须在阶段 2 之前就位。
  const adoptWorkspace = await registry.create(adoptDir)
  report.phases.push({ phase: 'create-adopt-workspace', path: adoptWorkspace.path, id: adoptWorkspace.id })
  const sessionOrphan = `session-${randomUUID()}`
  const sessionOffTarget = `session-${randomUUID()}`
  for (const [id, cwd] of [[sessionOrphan, adoptWorkspace.path], [sessionOffTarget, orphanDir]]) {
    const handle = await persistence.create({
      version: 4,
      id,
      createdAt: Date.now(),
      cwd,
      isSeeded: false,
      delegationDepth: 0
    })
    await handle.flush()
    await handle.close()
  }
  check('T0 准备：两条会话确实「无项目」（任何工作区的成员表里都没有）', [sessionOrphan, sessionOffTarget].every(
    (id) => registry.list().every((workspace) => workspace.sessionIds.includes(id) === false)
  ), { sessionOrphan, sessionOffTarget })

  // ── 阶段 2：健康一轮 → 台账应记下成员 ───────────────────────────
  await sleep(POLL_WAIT_MS)
  const ledgerHealthy = await readJson(ledgerFile)
  const entryKey = workspace.path.toLowerCase()
  const entry = ledgerHealthy.workspaces[entryKey]
  check('健康轮：台账建立并记下成员', entry !== undefined && entry.sessionIds.length === 2, {
    sessionIds: entry?.sessionIds,
    archivedSessionIds: entry?.archivedSessionIds
  })
  check('健康轮：插件还没归档任何会话', (entry?.archivedSessionIds ?? []).length === 0)

  // ── 阶段 3：删掉工作区目录 → 插件应归档 A（B 本来就归档了，不算它的账）──
  await rm(projectDir, { recursive: true, force: true })
  check('场景：工作区目录已删除', (await exists(projectDir)) === false)
  await sleep(POLL_WAIT_MS)

  const registryAfterDelete = await readJson(registryFile)
  const archivedAfterDelete = new Set(registryAfterDelete.global.archivedSessionIds)
  const ledgerAfterDelete = await readJson(ledgerFile)
  check('目录消失：官方归档集合包含会话 A', archivedAfterDelete.has(sessionA), { sessionA })
  check('目录消失：台账只记了 A 是插件归档的', JSON.stringify(ledgerAfterDelete.workspaces[entryKey]?.archivedSessionIds) === JSON.stringify([sessionA]), {
    archivedSessionIds: ledgerAfterDelete.workspaces[entryKey]?.archivedSessionIds
  })
  check('目录消失：用户手动归档的 B 仍归档（未被插件“接管”）', archivedAfterDelete.has(sessionB))

  // ── 阶段 4：把目录放回来 → 插件应恢复 A，且不碰 B ────────────────
  await mkdir(projectDir, { recursive: true })
  await sleep(POLL_WAIT_MS)

  const registryAfterReturn = await readJson(registryFile)
  const archivedAfterReturn = new Set(registryAfterReturn.global.archivedSessionIds)
  const ledgerAfterReturn = await readJson(ledgerFile)
  check('目录回归：会话 A 已恢复（不在归档集合里）', archivedAfterReturn.has(sessionA) === false, { sessionA })
  check('目录回归：用户手动归档的 B 仍然归档（关键安全断言）', archivedAfterReturn.has(sessionB) === true, { sessionB })
  check('目录回归：台账归档清单已清空', (ledgerAfterReturn.workspaces[entryKey]?.archivedSessionIds ?? []).length === 0)

  // ── 阶段 5：菜单里的「删除工作区」（只删登记、目录仍在）→ 归档；重新添加 → 恢复 ──
  await registry.delete(workspace.id)
  const registryAfterProjectDelete = await readJson(registryFile)
  const stillRegistered = Object.values(registryAfterProjectDelete.tables.workspaces)
    .some((row) => row.path.toLowerCase() === entryKey)
  check('删除项目：注册表里已无该项目，但目录仍然存在', stillRegistered === false && (await exists(projectDir)) === true)

  await sleep(POLL_WAIT_MS)
  const archivedAfterProjectDelete = new Set((await readJson(registryFile)).global.archivedSessionIds)
  check('删除项目（目录仍在）：会话 A 被归档', archivedAfterProjectDelete.has(sessionA), { sessionA })
  check('删除项目：用户手动归档的 B 不受影响', archivedAfterProjectDelete.has(sessionB) === true, { sessionB })

  await registry.create(projectDir) // 重新添加同一目录（新记录、空成员）
  await sleep(POLL_WAIT_MS)
  const archivedAfterReadd = new Set((await readJson(registryFile)).global.archivedSessionIds)
  check('重新添加目录：会话 A 自动恢复（靠台账交集，不靠新记录）', archivedAfterReadd.has(sessionA) === false, { sessionA })
  check('重新添加目录：用户手动归档的 B 仍然归档', archivedAfterReadd.has(sessionB) === true, { sessionB })

  // 官方语义：重新添加同一目录会新建**空成员**的项目（旧会话不会自动回来）。
  // 所以"取消归档"只是让会话不再隐藏，还必须把台账记过的成员挂回这个新项目，
  // 否则会散成「无项目」；**已经归档**的成员（例如用户手动归档的 B）同样要挂回分组，
  // 但归档状态绝不能被顺手改掉。
  const readdedRecord = Object.values((await readJson(registryFile)).tables.workspaces)
    .find((row) => row.path.toLowerCase() === entryKey)
  check('重新添加目录：会话 A 被挂回新项目（不再散成「无项目」）', (readdedRecord?.sessionIds ?? []).includes(sessionA), {
    sessionIds: readdedRecord?.sessionIds
  })
  check('重新添加目录：用户手动归档的 B 也被挂回新项目（只恢复分组）', (readdedRecord?.sessionIds ?? []).includes(sessionB), {
    sessionIds: readdedRecord?.sessionIds
  })
  check('重新添加目录：B 仍然归档 —— 挂回分组 ≠ 取消归档', archivedAfterReadd.has(sessionB) === true, { sessionB })

  // ── 阶段 6：T0「无项目 → 按 cwd 归位」────────────────────────────
  // 插件启动后只跑一次（adoptDelayMs 默认 5 秒）；这里轮询到出现为止，最多等 10 秒。
  const readRows = async () => Object.values((await readJson(registryFile)).tables.workspaces)
  let adopted = null
  for (let i = 0; i < 40 && adopted === null; i++) {
    const row = (await readRows()).find((entry) => entry.path.toLowerCase() === adoptWorkspace.path.toLowerCase())
    if (row !== undefined && (row.sessionIds ?? []).includes(sessionOrphan)) adopted = row
    else await sleep(250)
  }
  check('T0 归位：未分组、但 cwd 精确等于工作区路径的会话被插件自动挂回', adopted !== null, {
    sessionOrphan,
    workspacePath: adoptWorkspace.path
  })
  const rowsAfterAdopt = await readRows()
  check('T0 归位：cwd 没有对应工作区的会话**不**被塞进任何组（反例）', rowsAfterAdopt.every(
    (row) => (row.sessionIds ?? []).includes(sessionOffTarget) === false
  ), { sessionOffTarget })
  check('T0 归位：只挂一次，成员表里不重复', (adopted?.sessionIds ?? []).filter((id) => id === sessionOrphan).length <= 1, {
    sessionIds: adopted?.sessionIds
  })
  check('T0 归位：不新增工作区记录（归位 ≠ 建组）', rowsAfterAdopt.filter(
    (row) => row.path.toLowerCase() === adoptWorkspace.path.toLowerCase()
  ).length === 1, { workspaces: rowsAfterAdopt.map((row) => row.path) })

  // ── 阶段 7：斜杠命令入口（F021）──────────────────────────────────
  // 目的：把"命令真的注册进真宿主"和"命令真的能归档/恢复"变成端到端断言。
  // 用一个**专属**工作区 + 两个会话，避免干扰阶段 1–6 的断言。
  const commands = ctx.get('commands')
  check('命令服务存在（装置已挂 @deepseek-ai/dsh-commands）', commands !== undefined)

  // 对照：装置**自己**注册一条命令，证明 `find(undefined, …)`（无 agent 的全局查询）本身可用。
  // 它区分两种失败：查询路径不可用 vs 本插件没注册成功。
  let controlFound
  try {
    commands?.register({ name: 'rm-test-control', description: '装置对照命令', handler: () => ({ kind: 'success' }) })
    controlFound = commands?.find(undefined, 'rm-test-control')
  } catch (error) {
    report.phases.push({ phase: 'commands-control-threw', error: String(error) })
    controlFound = undefined
  }
  check('对照：装置自己注册的命令能被 find(undefined, …) 查到（证明查询路径可用）', controlFound !== undefined)

  // 对照 B：用**本插件同款的定义形状**（name/description/input.hint/handler）直接注册。
  // 它把"定义形状不被接受"与"插件的 inject 没触发"两种失败分开。
  let shapeFound
  try {
    commands?.register({
      name: 'rm-test-shape',
      description: '同款定义形状',
      input: { hint: '工作区路径或显示标题' },
      handler: async () => ({ kind: 'success', text: 'ok' })
    })
    shapeFound = commands?.find(undefined, 'rm-test-shape')
  } catch (error) {
    report.phases.push({ phase: 'commands-shape-threw', error: String(error) })
    shapeFound = undefined
  }
  check('对照 B：本插件同款定义形状能在真宿主注册成功', shapeFound !== undefined)

  // 对照 C：**完全照本插件的接线方式** —— 在 `ctx.inject([...])` 回调里注册。
  // 它把"inject 没触发 / scope.get 取不到"与"定义或注册本身的问题"彻底分开。
  let injectFound
  try {
    ctx.inject(['commands'], (scope) => {
      const c = typeof scope?.get === 'function' ? scope.get('commands') : undefined
      report.phases.push({ phase: 'commands-inject', scopeIsUndefined: scope === undefined, gotService: c !== undefined })
      c?.register({ name: 'rm-test-inject', description: 'inject 对照', handler: async () => ({ kind: 'success' }) })
    })
    await sleep(500)
    injectFound = commands?.find(undefined, 'rm-test-inject')
  } catch (error) {
    report.phases.push({ phase: 'commands-inject-threw', error: String(error) })
    injectFound = undefined
  }
  check('对照 C：从 ctx.inject([commands]) 回调里注册的命令可见', injectFound !== undefined)

  let archiveCommand
  try {
    // 插件在普通上下文注册 = 全局命令；没有 agent 时按全局层查。
    archiveCommand = commands?.find(undefined, 'archive-workspace')
  } catch (error) {
    report.phases.push({ phase: 'commands-find-threw', error: String(error) })
    archiveCommand = undefined
  }
  check('斜杠命令已注册进真宿主注册表：/archive-workspace', archiveCommand !== undefined, {
    mounted: commands !== undefined
  })
  let restoreCommand
  try {
    restoreCommand = commands?.find(undefined, 'restore-workspace')
  } catch {
    restoreCommand = undefined
  }
  check('斜杠命令已注册进真宿主注册表：/restore-workspace', restoreCommand !== undefined)

  if (archiveCommand !== undefined && restoreCommand !== undefined) {
    const cmdDir = join(root, '.verify', 'proj-cmd')
    await mkdir(cmdDir, { recursive: true })
    const cmdWorkspace = await registry.create(cmdDir)
    const cmdA = `session-${randomUUID()}`
    const cmdB = `session-${randomUUID()}`
    for (const id of [cmdA, cmdB]) {
      const handle = await persistence.create({
        version: 4,
        id,
        createdAt: Date.now(),
        cwd: cmdWorkspace.path,
        isSeeded: false,
        delegationDepth: 0
      })
      await handle.flush()
      await handle.close()
      await cmdWorkspace.attachSession(id)
    }
    const signal = new AbortController().signal

    // 直接调 handler：验证"注册成功"之外的**行为**（rawInput 里的分隔空白由引擎 trim）。
    const archived = await archiveCommand.handler({ rawInput: `  ${cmdWorkspace.path}  `, signal })
    check('命令 /archive-workspace 返回 success', archived?.kind === 'success', { result: archived })
    const afterArchive = new Set((await readJson(registryFile)).global.archivedSessionIds ?? [])
    check('命令真的归档了该工作区的会话（以真注册表为准）', afterArchive.has(cmdA) && afterArchive.has(cmdB), {
      cmdA,
      cmdB
    })

    const restored = await restoreCommand.handler({ rawInput: cmdWorkspace.path, signal })
    check('命令 /restore-workspace 返回 success', restored?.kind === 'success', { result: restored })
    const afterRestore = new Set((await readJson(registryFile)).global.archivedSessionIds ?? [])
    check('命令真的放回了那批（恢复走的仍是 D015 的独立清单）', afterRestore.has(cmdA) === false && afterRestore.has(cmdB) === false, {
      cmdA,
      cmdB
    })

    const unknown = await archiveCommand.handler({ rawInput: 'no-such-workspace-xyz', signal })
    check('命令对未知工作区返回 error（不猜、不动数据）', unknown?.kind === 'error', { result: unknown })
  }

  // ── 阶段 8：文件夹改名场景复现（F022 / 官方讨论 #3012 的地基）────
  // 目的：把"改文件夹名之后**今天**到底会怎样"变成可断言的事实，而不是猜。
  // 本阶段**只观察、不做任何写修复**。用专属目录，避免干扰前面阶段。
  const renameOld = join(root, '.verify', 'proj-rename')
  const renameNew = join(root, '.verify', 'proj-renamed')
  await rm(renameOld, { recursive: true, force: true })
  await rm(renameNew, { recursive: true, force: true })
  await mkdir(renameOld, { recursive: true })

  const renameWs = await registry.create(renameOld)
  const renameSession = `session-${randomUUID()}`
  {
    const handle = await persistence.create({
      version: 4,
      id: renameSession,
      createdAt: Date.now(),
      cwd: renameWs.path,
      isSeeded: false,
      delegationDepth: 0
    })
    await handle.flush()
    await handle.close()
    await renameWs.attachSession(renameSession)
  }
  await sleep(POLL_WAIT_MS) // 给插件一轮健康对账，把它记进台账

  const headerBefore = (await persistence.list()).find((item) => item.header.id === renameSession)?.header
  check('改名前：会话 header.cwd 精确等于工作区路径（这是 attach 的前提）', headerBefore?.cwd === renameWs.path, {
    cwd: headerBefore?.cwd,
    path: renameWs.path
  })

  // —— 用户在资源管理器里改名：等价于一次 fs rename ——
  await rename(renameOld, renameNew)
  await sleep(POLL_WAIT_MS * 2) // watcher 触发 + confirmDelayMs=0 的确认轮

  check('改名后：官方 status() 变成 missing-dir（登记仍停在旧路径）', (await renameWs.status()) === 'missing-dir')
  const rowsAfterRename = await readRows()
  check(
    '改名后：注册表里**没有**新路径的记录（官方不会跟随改名）',
    rowsAfterRename.every((row) => row.path.toLowerCase() !== renameNew.toLowerCase()),
    { paths: rowsAfterRename.map((row) => row.path) }
  )
  // 注册表 `workspaces` 是 `KvTable<WorkspaceId, WorkspaceRecord>`：id 是**映射的键**，不是记录的字段。
  const rowMap = (await readJson(registryFile)).tables.workspaces
  check(
    '改名后：旧路径的登记仍在、成员表也还在（此刻尚未被 prune）',
    (rowMap[renameWs.id]?.sessionIds ?? []).includes(renameSession),
    { sessionIds: rowMap[renameWs.id]?.sessionIds }
  )

  // ⚠️ 核心发现（2026-10-11 实测）：改名**不会**立刻让插件归档。
  const entryAfterRename = (await readJson(ledgerFile)).workspaces[renameWs.path.toLowerCase()]
  check(
    '改名后：台账里这条工作区**已经记过** ⇒ "没归档"不是因为它没被跟踪',
    (entryAfterRename?.sessionIds ?? []).includes(renameSession),
    { sessionIds: entryAfterRename?.sessionIds }
  )
  check(
    '⚠️ 改名后：台账 missingSince 仍是 null ⇒ 插件**根本没被叫醒**（watcher 拿到的 filename 是新名字，不在被跟踪的 basename 集合里，事件被过滤掉了）',
    entryAfterRename !== undefined && entryAfterRename.missingSince === null,
    { missingSince: entryAfterRename?.missingSince }
  )
  check(
    '改名后：因此这条会话此刻**还没有**被归档（对照组：删目录会走同一条链路并在同一窗口内归档）',
    new Set((await readJson(registryFile)).global.archivedSessionIds ?? []).has(renameSession) === false,
    { renameSession }
  )

  const sessionRoot = join(home, 'sessions')
  let foundSlug = null
  for (const slug of await readdir(sessionRoot)) {
    if (await exists(join(sessionRoot, slug, renameSession))) {
      foundSlug = slug
      break
    }
  }
  check(
    '改名后：会话日志仍在盘上，且位于**旧路径**对应的 project 目录下（不会自己跟着目录走）',
    foundSlug !== null && foundSlug.toLowerCase().includes('renamed') === false,
    { foundSlug }
  )

  // —— 把改名后的目录当"新工作区"重新添加：官方只能新建一条空记录 ——
  // 这一步同时会发 `domain/changed`，等于**强制叫醒**插件。
  const readdAfterRename = await registry.create(renameNew)
  check(
    '重新添加新路径：得到一条**新的**工作区（新 id、0 成员），旧记录不会被复用',
    readdAfterRename.id !== renameWs.id && readdAfterRename.sessionIds.length === 0,
    { oldId: renameWs.id, newId: readdAfterRename.id }
  )

  await sleep(POLL_WAIT_MS)
  check(
    '被 domain/changed 叫醒之后：插件**立刻**把它归档了 ⇒ 缺的只是"醒来"，判据本身没问题',
    new Set((await readJson(registryFile)).global.archivedSessionIds ?? []).has(renameSession) === true
  )

  let attachRefusal = null
  try {
    await readdAfterRename.attachSession(renameSession)
  } catch (error) {
    attachRefusal = error
  }
  check(
    '重新添加新路径：**旧会话挂不过去**（attachSession 要求 header.cwd === 新路径）',
    attachRefusal !== null,
    { error: String(attachRefusal) }
  )
  const rowsAfterReadd = await readRows()
  check(
    '挂失败之后：新记录仍然是空的（校验先于写入，不产生半成品）',
    (rowsAfterReadd.find((row) => row.id === readdAfterRename.id)?.sessionIds ?? []).length === 0
  )
  check(
    '此时该会话是归档态 ⇒ 用户看到的是「历史被藏起来、而且挂不回新工作区」',
    new Set((await readJson(registryFile)).global.archivedSessionIds ?? []).has(renameSession) === true
  )

  console.log('\n── 真实注册表（测试 DSH_HOME）──')
  console.log(JSON.stringify({ archivedSessionIds: [...archivedAfterReadd] }, null, 2))
  console.log('── 台账 ──')
  console.log(JSON.stringify(await readJson(ledgerFile), null, 2))
} finally {
  await ctx.fiber.dispose()
}

const userArchivedAfter = await userArchivedCount()
check('只读边界：用户真实 ~/.dsh 注册表归档数未变', userArchivedBefore === userArchivedAfter, {
  before: userArchivedBefore,
  after: userArchivedAfter
})

const failed = report.checks.filter((item) => item.ok === false)
console.log(`\n结果：${report.checks.length - failed.length}/${report.checks.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1
