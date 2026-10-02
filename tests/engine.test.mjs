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
    members: ['s1', 's2'],
    archived: new Set(options.archived ?? []),
    active: new Set(options.active ?? []),
    calls: []
  }

  const registry = {
    list: () => [{
      path: state.path,
      title: state.title,
      get sessionIds() {
        return state.exists ? [...state.members] : []
      },
      status: async () => (state.exists ? 'ok' : 'missing-dir')
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

async function makeEngine(world, overrides = {}) {
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, 'engine-'))
  const file = join(dir, 'ledger.json')
  const ledger = new LedgerStore(file)
  await ledger.load()
  const logs = []
  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 60000, missingConfirmations: 3, dryRun: false, ...overrides },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message])
    }
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

test('缺失先去抖：前两轮不动，第三轮归档台账里的成员', async () => {
  const world = fakeWorld()
  const { engine, file } = await makeEngine(world)
  await engine.tick()

  world.state.exists = false
  await engine.tick()
  await engine.tick()
  assert.deepEqual(world.state.calls, [], '未达确认次数不得归档')

  // 关键：目录缺失后官方 sessionIds 已经为空，归档名单只能来自台账。
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

test('台账独有路径（已从注册表移除）：目录回来时也能恢复', async () => {
  const world = fakeWorld({ archived: [] })
  const { engine, ledger, file } = await makeEngine(world)
  await engine.tick()
  world.state.exists = false
  await engine.tick()
  await engine.tick()
  await engine.tick()
  const archivedBefore = ledger.entry('<repo>\\proj').archivedSessionIds
  assert.deepEqual(archivedBefore, ['s1', 's2'])

  // 模拟用户把工作区从注册表移除、但目录又回来了：注册表为空，靠 stat 发现目录存在。
  world.registry.list = () => []
  const seen = []
  const engine2 = createEngine({
    registry: world.registry,
    ledger,
    config: { pollIntervalMs: 60000, missingConfirmations: 3, dryRun: false },
    logger: { info: (m) => seen.push(m), warn: (m) => seen.push(m) },
    statDirectory: async () => true
  })
  await engine2.tick()

  assert.deepEqual(world.state.calls.slice(-2), [['unarchive', 's1'], ['unarchive', 's2']])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.workspaces['<repo>\\proj'].archivedSessionIds, [])
})
