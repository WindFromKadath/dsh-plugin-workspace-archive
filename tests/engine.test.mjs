/**
 * 引擎端到端测试（F003–F005 的仓库级验收）：
 * 用假注册表 + 假文件系统 + 真台账，跑完整的「健康 → 缺失 → 归档 → 回归 → 恢复」。
 *
 * 重点验证两条硬约束：
 *   ① 目录缺失那一次，官方 `sessionIds` 已经被过滤为空 —— 只能靠台账里的成员；
 *   ② 台账必须**先落盘、后调官方归档**（否则 id 会被下一次 workspace 写操作永久 prune）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LedgerStore } from '../src/ledger.js'
import { createEngine } from '../src/index.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))

/**
 * 假世界：一个工作区 + 官方归档集合 + 调用记录。
 * 目录消失后 `sessionIds` 变空，模拟真机 `WorkspaceEntity.sessionIds` 的过滤行为。
 */
function fakeWorld(options = {}) {
  const state = {
    exists: true,
    path: '<repo>\\proj',
    title: 'proj',
    workspaceId: options.workspaceId ?? 'ws-1',
    members: ['s1', 's2'],
    archived: new Set(options.archived ?? []),
    active: new Set(options.active ?? []),
    calls: []
  }

  const registry = {
    list: () => [{
      id: state.workspaceId,
      path: state.path,
      title: state.title,
      get sessionIds() {
        return state.exists ? [...state.members] : []
      },
      status: async () => (state.exists ? 'ok' : 'missing-dir'),
      /**
       * 官方 `Workspace.attachSession`：自带 `cwd === 工作区路径` 校验，且是**前插**
       * （新成员排在最前）。「删除项目后重新添加同一目录」时应用会建一个空成员的新记录，
       * 插件必须靠它把恢复出来的会话挂回去，否则会话会散成「无项目」。
       */
      async attachSession(sessionId) {
        state.calls.push(['attach', sessionId])
        if (state.exists === false) throw new Error('cannot attach: the path is not a directory')
        if (state.members.includes(sessionId) === false) state.members.unshift(sessionId)
      }
    }],
    /** 官方归档集合快照：引擎靠它区分「用户手动归档」与「本插件归档」。 */
    get archivedSessionIds() {
      return [...state.archived]
    },
    async archiveSession(sessionId) {
      state.calls.push(['archive', sessionId])
      if (state.active.has(sessionId)) {
        const error = new Error(`session ${sessionId} has running work`)
        error.name = 'WorkspaceActiveSessionError'
        error.activity = [{ family: 'turn', items: [{ id: sessionId }] }]
        throw error
      }
      state.archived.add(sessionId)
    },
    async unarchiveSession(sessionId) {
      state.calls.push(['unarchive', sessionId])
      state.archived.delete(sessionId)
    }
  }

  return { state, registry }
}

async function makeEngine(world, overrides = {}, deps = {}) {
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, 'engine-'))
  const file = join(dir, 'ledger.json')
  const ledger = new LedgerStore(file)
  await ledger.load()
  const logs = []
  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 300000, confirmDelayMs: 0, dryRun: false, ...overrides },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message])
    },
    // 测试里不自动跟进对账（那由专门的用例用假定时器验证），避免与手写 tick 竞争。
    timers: { setTimeout: () => null, clearTimeout: () => {} },
    ...deps
  })
  return { engine, ledger, file, logs }
}

test('健康一轮：把成员记进台账，不动官方数据', async () => {
  const world = fakeWorld()
  const { engine, ledger, file } = await makeEngine(world)

  await engine.tick()

  assert.deepEqual(world.state.calls, [])
  assert.deepEqual(ledger.entry('<repo>\\proj').sessionIds, ['s1', 's2'])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.workspaces['<repo>\\proj'].sessionIds, ['s1', 's2'])
})

test('确认窗口（时间型）：第一轮只计时，窗口到点后的下一轮才归档', async () => {
  const world = fakeWorld()
  let clock = 1000
  const { engine, file } = await makeEngine(world, { confirmDelayMs: 3000 }, { now: () => clock })
  await engine.tick()

  world.state.exists = false
  await engine.tick()
  assert.deepEqual(world.state.calls, [], '第一次看到消失只开始计时')

  clock = 2500 // 还在窗口内
  await engine.tick()
  assert.deepEqual(world.state.calls, [], '窗口内不得归档')

  // 关键：目录缺失后官方 sessionIds 已经为空，归档名单只能来自台账。
  clock = 4500 // 已过 3 秒窗口
  await engine.tick()
  assert.deepEqual(world.state.calls, [['archive', 's1'], ['archive', 's2']])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.workspaces['<repo>\\proj'].archivedSessionIds, ['s1', 's2'])
  assert.ok(typeof onDisk.workspaces['<repo>\\proj'].missingSince === 'string')
})

test('台账先落盘、后调官方归档（防 prune 的硬约束）', async () => {
  const world = fakeWorld()
  const { engine, file } = await makeEngine(world)
  await engine.tick()
  world.state.exists = false

  // 在第一次官方归档调用的瞬间读盘：台账必须已经包含要归档的 id。
  let snapshotAtFirstArchive
  const originalArchive = world.registry.archiveSession
  world.registry.archiveSession = async (sessionId) => {
    if (snapshotAtFirstArchive === undefined) snapshotAtFirstArchive = JSON.parse(await readFile(file, 'utf8'))
    return originalArchive(sessionId)
  }

  await engine.tick()
  await engine.tick()
  await engine.tick()

  assert.equal(snapshotAtFirstArchive !== undefined, true, '官方归档确实被调用')
  assert.deepEqual(snapshotAtFirstArchive.workspaces['<repo>\\proj'].archivedSessionIds, ['s1', 's2'])
})

test('仍有工作在跑的会话被跳过，其余照常归档', async () => {
  const world = fakeWorld({ active: ['s2'] })
  const { engine, logs } = await makeEngine(world)
  await engine.tick()
  world.state.exists = false
  await engine.tick()
  await engine.tick()
  await engine.tick()

  assert.deepEqual(world.state.calls, [['archive', 's1'], ['archive', 's2']])
  assert.equal(world.state.archived.has('s1'), true)
  assert.equal(world.state.archived.has('s2'), false, '运行中的会话不得被强行归档')
  assert.ok(logs.some(([level, message]) => level === 'warn' && /跳过仍在运行/.test(message)))
})

test('目录回归：只恢复本插件归档过的会话，用户手动归档不受影响', async () => {
  const world = fakeWorld({ archived: ['user-manual-1'] })
  const { engine, ledger } = await makeEngine(world)
  await engine.tick()
  world.state.exists = false
  await engine.tick()
  await engine.tick()
  await engine.tick()
  assert.deepEqual([...world.state.archived].sort(), ['s1', 's2', 'user-manual-1'])

  world.state.calls.length = 0
  world.state.exists = true
  await engine.tick()

  assert.deepEqual(world.state.calls, [['unarchive', 's1'], ['unarchive', 's2']])
  assert.equal(world.state.archived.has('user-manual-1'), true, '用户自己归档的会话必须原样保留')
  assert.deepEqual(ledger.entry('<repo>\\proj').archivedSessionIds, [], '恢复后台账归档清单清空')
})

test('回归：用户手动归档的**成员**不会被插件据为己有，也不会被恢复', async () => {
  // 真机测试抓到的洞：官方 archiveSession 对已归档 id 幂等，若不先看官方归档集合，
  // 插件会把用户手动归档的成员也记进自己台账，恢复时一并解除归档。
  const world = fakeWorld({ archived: ['s2'] })
  const { engine, ledger } = await makeEngine(world)

  await engine.tick() // 健康轮：s1、s2 都是成员
  assert.deepEqual(world.state.archived.has('s2'), true)

  world.state.exists = false
  await engine.tick()
  await engine.tick()
  await engine.tick()
  assert.equal(world.state.archived.has('s1'), true, '插件应归档 s1')
  assert.deepEqual(ledger.entry('<repo>\\proj').archivedSessionIds, ['s1'], '台账只能记自己归档的 s1')

  world.state.exists = true
  world.state.calls.length = 0
  await engine.tick()

  assert.deepEqual(world.state.calls, [['unarchive', 's1']])
  assert.equal(world.state.archived.has('s2'), true, '用户手动归档的 s2 必须仍然归档')
})

test('dryRun：只记日志，不动注册表、不写台账', async () => {
  const world = fakeWorld()
  const { engine, ledger, file } = await makeEngine(world, { dryRun: true })
  await engine.tick()
  world.state.exists = false
  await engine.tick()
  await engine.tick()
  await engine.tick()

  assert.deepEqual(world.state.calls, [])
  assert.equal(ledger.persist, false)
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/)
})

test('「删除工作区」（项目登记被移除、目录仍在）→ 归档；重新添加同一目录 → 恢复并挂回工作区', async () => {
  // 用户 2026-10-02 确认的语义：菜单里的"删除工作区"只删登记、不动文件夹，
  // 所以不能只看目录存在性——登记没了也算消失。
  const world = fakeWorld({ archived: [] })
  const listRegistered = world.registry.list
  const { engine, ledger } = await makeEngine(world)
  await engine.tick() // 健康轮：台账记下 s1、s2
  assert.equal(world.state.exists, true, '整个用例里目录始终存在')

  world.registry.list = () => [] // 用户点「删除工作区」
  await engine.tick()
  await engine.tick()
  await engine.tick()

  assert.deepEqual(world.state.calls, [['archive', 's1'], ['archive', 's2']])
  assert.deepEqual(ledger.entry('<repo>\\proj').archivedSessionIds, ['s1', 's2'])

  // 重新添加同一目录：官方语义是**新建一个空成员的项目**（旧会话不会自动回来）。
  // ⇒ 插件只取消归档还不够，必须再把会话挂回新项目；否则它们会散成「无项目」。
  //    这是 2026-10-07 用户真机反馈的缺口（Rust 工作区：恢复了但没加回工作区）。
  world.state.calls.length = 0
  world.state.members = [] // ← 新记录：空成员
  world.state.workspaceId = 'ws-2' // ← 新记录：新 id（旧记录已被 delete 掉）
  world.registry.list = listRegistered
  await engine.tick()

  assert.deepEqual(world.state.calls, [
    ['unarchive', 's1'], ['unarchive', 's2'],
    ['attach', 's2'], ['attach', 's1'] // attachSession 是前插，倒序挂回才能保持原相对顺序
  ])
  assert.deepEqual(world.state.members, ['s1', 's2'], '恢复后必须挂回工作区，且保持原来的相对顺序')
  assert.deepEqual(ledger.entry('<repo>\\proj').archivedSessionIds, [])
})

test('重新添加同一目录（插件当时没在跑：台账没有 missingSince、工作区 id 变了）→ 按台账把成员挂回', async () => {
  // 用户 2026-10-07 真机反馈的第二种情形：会话在消失**之前就已经是归档状态**（尤其是
  // 用户自己手动归档的）。官方记录被删掉重建后，新记录是空成员表 —— 光恢复"本插件归档过的
  // 那批"不够，用户归档的那批也要把**分组**挂回去，但**绝不能动它的归档状态**。
  const world = fakeWorld({ archived: ['s2'], workspaceId: 'ws-2' })
  world.state.members = [] // 新记录：空成员
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, 'engine-'))
  const ledger = new LedgerStore(join(dir, 'ledger.json'))
  // 模拟"插件上次跑时"记下的快照：旧记录 ws-1 的成员是 s1、s2，且当时什么都没归档。
  ledger.syncHealthy('<repo>\\proj', 'proj', ['s1', 's2'], 'ws-1')

  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 300000, confirmDelayMs: 0, dryRun: false, watch: false },
    logger: {},
    timers: { setTimeout: () => null, clearTimeout: () => {} }
  })
  await engine.tick()

  assert.deepEqual(world.state.members, ['s1', 's2'], '台账记过的成员都要挂回新记录，且保持原相对顺序')
  assert.equal(world.state.archived.has('s2'), true, '用户手动归档的 s2 必须仍然归档')
  assert.equal(world.state.archived.has('s1'), false, 's1 本来没归档，不得被莫名归档')
  assert.equal(world.state.calls.some((call) => call[0] === 'unarchive'), false, '没有本插件归档过的会话时不得调 unarchive')
  assert.deepEqual(ledger.entry('<repo>\\proj').archivedSessionIds, [], '不得把用户归档的会话记成自己的账')
})

test('平时（没经历过消失、记录 id 没变）不重挂：用户手动移出工作区的成员不会被塞回去', async () => {
  const world = fakeWorld()
  const { engine } = await makeEngine(world)
  await engine.tick() // 健康轮：台账记下 s1、s2（ws-1）

  world.state.calls.length = 0
  world.state.members = ['s1'] // 用户把 s2 移出工作区
  await engine.tick()

  assert.deepEqual(world.state.calls, [], '不得把用户移出的成员又挂回去')
  assert.deepEqual(world.state.members, ['s1'])
})

test('启动瞬态保护：注册表从未非空时，不把台账路径当作「项目被移除」', async () => {
  const world = fakeWorld()
  world.registry.list = () => [] // 模拟注册表 bootstrap 尚未完成
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, 'engine-'))
  const ledger = new LedgerStore(join(dir, 'ledger.json'))
  ledger.syncHealthy('<repo>\\proj', 'proj', ['s1', 's2']) // 台账里有，但注册表没见过非空

  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 300000, confirmDelayMs: 0, dryRun: false },
    logger: {},
    timers: { setTimeout: () => null, clearTimeout: () => {} }
  })
  await engine.tick()
  await engine.tick()
  await engine.tick()

  assert.deepEqual(world.state.calls, [], '未见过非空注册表时不得据"登记消失"归档')
})

test('事件入口：notifyChange() 会合并触发一轮对账（注册表事件走这里）', async () => {
  const world = fakeWorld()
  const { engine } = await makeEngine(world, { changeDelayMs: 0 })
  await engine.tick() // 健康轮：台账记下成员

  world.state.exists = false
  await engine.notifyChange() // 第一次：只开始计时
  await engine.notifyChange() // 第二次：confirmDelayMs=0 → 归档
  assert.deepEqual(world.state.calls, [['archive', 's1'], ['archive', 's2']])
})

test('watcher 事件：目录被改名会触发对账（宿主对目录消失没有事件）', async () => {
  const world = fakeWorld()
  const watchers = []
  const fakeWatch = (parent, _options, listener) => {
    const watcher = { parent, listener, closed: false, on() {}, close() { this.closed = true } }
    watchers.push(watcher)
    return watcher
  }
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, 'engine-'))
  const ledger = new LedgerStore(join(dir, 'ledger.json'))
  await ledger.load()
  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 300000, confirmDelayMs: 0, dryRun: false, watch: true },
    logger: {},
    watch: fakeWatch,
    timers: { setTimeout: () => null, clearTimeout: () => {} },
    changeDelayMs: 0
  })

  await engine.tick()
  assert.equal(watchers.length, 1, '应给工作区目录的父目录挂一个 watcher')
  assert.equal(watchers[0].parent.toLowerCase(), '<repo>')

  world.state.exists = false
  watchers[0].listener('rename', 'proj') // 目录被改名 → 触发对账
  await new Promise((resolve) => setTimeout(resolve, 20))
  await engine.tick() // 第二次观察 → 归档（confirmDelayMs=0）

  assert.deepEqual(world.state.calls, [['archive', 's1'], ['archive', 's2']])
  engine.dispose()
  assert.equal(watchers[0].closed, true, 'dispose 应关掉 watcher')
})

test('确认窗口的跟进对账：窗口到点会自己再跑一轮（否则要等兜底轮询）', async () => {
  const world = fakeWorld()
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, 'engine-'))
  const ledger = new LedgerStore(join(dir, 'ledger.json'))
  await ledger.load()
  const scheduled = []
  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 300000, confirmDelayMs: 3000, dryRun: false, watch: false },
    logger: {},
    timers: {
      setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} } },
      clearTimeout: () => {}
    },
    changeDelayMs: 0
  })

  await engine.tick() // 健康轮
  world.state.exists = false
  await engine.tick() // 第一次看到消失 → 开始计时并安排跟进

  assert.equal(scheduled.length, 1, '开始计时后应安排一次跟进对账')
  assert.equal(scheduled[0].ms, 3050, '跟进延迟 = 确认窗口 + 余量')

  // 手工触发那次跟进：此时仍未过窗口（now 没变），不应归档
  scheduled[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(world.state.calls, [], '跟进时若仍在窗口内则不动作')
})
