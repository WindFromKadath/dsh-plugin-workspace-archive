/**
 * 在线层测试：意图解析（纯）、该 attach/detach 谁（纯）、引擎真的按意图调官方 API。
 *
 * 关键验收：**归档态不用补偿** —— 迁移只动 cwd 与成员表，官方归档集合（会话 id 的全局集合）
 * 不受影响 ⇒ 原本归档的会话在新组里仍然归档。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEngine } from '../src/index.js'
import { LedgerStore } from '../src/ledger.js'
import { parseMigrationIntent, planMigrationStep } from '../src/migrate.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))

const FROM = '<repo>\\from'
const TO = '<repo>\\to'

/** 一个能 attach/detach 的假世界。 */
function fakeWorld(options = {}) {
  const state = {
    workspaces: [
      { id: 'ws-from', path: FROM, sessionIds: [...(options.from ?? ['s1', 's2'])] },
      { id: 'ws-to', path: TO, sessionIds: [...(options.to ?? [])] }
    ],
    archived: new Set(options.archived ?? []),
    calls: []
  }
  const entity = (row) => ({
    id: row.id,
    path: row.path,
    get sessionIds() { return [...row.sessionIds] },
    status: async () => 'ok',
    async attachSession(sessionId) {
      state.calls.push(['attach', row.id, sessionId])
      if (row.sessionIds.includes(sessionId) === false) row.sessionIds.unshift(sessionId)
    },
    async detachSession(sessionId) {
      state.calls.push(['detach', row.id, sessionId])
      row.sessionIds = row.sessionIds.filter((id) => id !== sessionId)
    }
  })
  return {
    state,
    registry: {
      list: () => state.workspaces.map(entity),
      get: (id) => {
        const row = state.workspaces.find((item) => item.id === id)
        return row === undefined ? undefined : entity(row)
      },
      get archivedSessionIds() { return [...state.archived] },
      async archiveSession(sessionId) { state.archived.add(sessionId) },
      async unarchiveSession(sessionId) { state.archived.delete(sessionId) }
    }
  }
}

async function tempDir(prefix) {
  await mkdir(tmpRoot, { recursive: true })
  return mkdtemp(join(tmpRoot, prefix))
}

async function makeEngine(world, overrides = {}) {
  const dir = await tempDir('migrate-')
  const intentPath = join(dir, 'pending-migrations.json')
  const ledger = new LedgerStore(join(dir, 'ledger.json'))
  await ledger.load()
  const logs = []
  const engine = createEngine({
    registry: world.registry,
    ledger,
    config: {
      pollIntervalMs: 300000, confirmDelayMs: 0, dryRun: false, watch: false,
      migrationIntentPath: intentPath, ...overrides
    },
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
    timers: { setTimeout: () => null, clearTimeout: () => {} }
  })
  return { engine, intentPath, logs, dir }
}

const intentText = (sessions, toCwd = TO, fromCwd = FROM) => JSON.stringify({
  version: 1, createdAt: '2026-10-11T00:00:00.000Z', fromCwd, toCwd, sessions
})

// ── 纯函数 ────────────────────────────────────────────────

test('意图解析：形状不对一律 fail-closed', () => {
  assert.equal(parseMigrationIntent('not json').ok, false)
  assert.equal(parseMigrationIntent('[]').reason, 'intent-is-not-an-object')
  assert.equal(parseMigrationIntent('{"version":2}').reason, 'unsupported-intent-version (2)')
  assert.equal(parseMigrationIntent('{"version":1}').reason, 'intent-has-no-toCwd')
  assert.equal(parseMigrationIntent('{"version":1,"toCwd":"X"}').reason, 'intent-has-no-sessions-array')
  assert.equal(parseMigrationIntent('{"version":1,"toCwd":"X","sessions":[]}').reason, 'intent-has-no-sessions')
  assert.equal(parseMigrationIntent('{"version":1,"toCwd":"X","sessions":[""]}').reason, 'intent-sessions-must-be-non-empty-strings')
  assert.equal(parseMigrationIntent(intentText(['s1'])).ok, true)
})

test('决策：目标工作区没登记 ⇒ 不能处理，也不猜', () => {
  const step = planMigrationStep({ toCwd: '<repo>\\nowhere', fromCwd: FROM, sessions: ['s1'] }, [
    { id: 'ws-from', path: FROM, sessionIds: ['s1'] }
  ])
  assert.equal(step.ok, false)
  assert.match(step.reason, /target-workspace-not-registered/)
})

test('决策：attach 只列不在目标组里的；detach 只列仍在源组里的', () => {
  const step = planMigrationStep({ toCwd: TO, fromCwd: FROM, sessions: ['s1', 's2', 's3'] }, [
    { id: 'ws-from', path: FROM, sessionIds: ['s2', 's3'] },
    { id: 'ws-to', path: TO, sessionIds: ['s1'] }
  ])
  assert.equal(step.ok, true)
  assert.deepEqual(step.attach, ['s2', 's3'])
  assert.deepEqual(step.detach, ['s2', 's3'])
  assert.equal(step.noop, false)
})

test('决策：全都在位且旧组不留人 ⇒ noop（同一份意图重跑是安全的）', () => {
  const step = planMigrationStep({ toCwd: TO, fromCwd: FROM, sessions: ['s1'] }, [
    { id: 'ws-from', path: FROM, sessionIds: [] },
    { id: 'ws-to', path: TO, sessionIds: ['s1'] }
  ])
  assert.equal(step.noop, true)
})

test('决策：源工作区已经不在列表里（改名后常见）⇒ 只 attach，不报错', () => {
  const step = planMigrationStep({ toCwd: TO, fromCwd: FROM, sessions: ['s1'] }, [
    { id: 'ws-to', path: TO, sessionIds: [] }
  ])
  assert.equal(step.ok, true)
  assert.equal(step.source, null)
  assert.deepEqual(step.attach, ['s1'])
  assert.deepEqual(step.detach, [])
})

// ── 引擎接线 ──────────────────────────────────────────────

test('引擎：没有意图文件时什么都不做', async () => {
  const world = fakeWorld()
  const { engine } = await makeEngine(world)
  await engine.tick()
  assert.deepEqual(world.state.calls, [])
})

test('引擎：按意图官方 attach 到新组、从旧组 detach，并消费掉意图', async () => {
  const world = fakeWorld()
  const { engine, intentPath, dir } = await makeEngine(world)
  await writeFile(intentPath, intentText(['s1', 's2']), 'utf8')

  await engine.tick()

  assert.deepEqual(world.state.calls, [
    ['attach', 'ws-to', 's1'], ['attach', 'ws-to', 's2'],
    ['detach', 'ws-from', 's1'], ['detach', 'ws-from', 's2']
  ])
  // ⚠️ 官方 `attachSession` 是**前插** ⇒ 先挂 s1 再挂 s2，最终顺序是 ['s2','s1']。
  // 所以离线层写意图时按 `createdAt` **升序**排，挂完就正好是官方惯例的"新的在前"。
  assert.deepEqual(world.state.workspaces[1].sessionIds, ['s2', 's1'])
  assert.deepEqual(world.state.workspaces[0].sessionIds, [])
  // 意图被消费：待处理文件没了，留痕文件在
  const files = await readdir(dir)
  assert.equal(files.includes('pending-migrations.json'), false)
  const consumed = files.find((name) => name.startsWith('consumed-migrations-'))
  assert.ok(consumed !== undefined, files.join(' / '))
  const record = JSON.parse(await readFile(join(dir, consumed), 'utf8'))
  assert.deepEqual(record.attached, ['s1', 's2'])
  assert.deepEqual(record.detached, ['s1', 's2'])
  assert.equal(record.targetPath, TO)
})

test('引擎：**归档态不受影响** —— 原本归档的会话在新组里仍然归档', async () => {
  const world = fakeWorld({ archived: ['s1'], from: ['s1', 's2'] })
  const { engine, intentPath } = await makeEngine(world)
  await writeFile(intentPath, intentText(['s1', 's2']), 'utf8')

  await engine.tick()

  assert.deepEqual(world.state.workspaces[1].sessionIds, ['s2', 's1'])
  assert.equal(world.state.archived.has('s1'), true, '原本归档的必须仍然归档')
  assert.equal(world.state.archived.has('s2'), false)
  // 迁移过程不许碰归档集合
  assert.deepEqual(world.state.calls.filter(([kind]) => kind === 'archive' || kind === 'unarchive'), [])
})

test('引擎：同一份意图重跑是幂等的（消费之后不会再动）', async () => {
  const world = fakeWorld()
  const { engine, intentPath } = await makeEngine(world)
  await writeFile(intentPath, intentText(['s1']), 'utf8')
  await engine.tick()
  const after = world.state.calls.length
  await engine.tick()
  assert.equal(world.state.calls.length, after, '第二次 tick 不该再动任何东西')
})

test('引擎：目标工作区还没登记 ⇒ 意图**保持待处理**，之后登记了再处理', async () => {
  const world = fakeWorld()
  const { engine, intentPath, logs } = await makeEngine(world)
  await writeFile(intentPath, intentText(['s1'], '<repo>\\not-yet'), 'utf8')

  await engine.tick()
  await engine.tick()
  assert.deepEqual(world.state.calls, [], '目标不在就一条都不许动')
  assert.equal((await readdir(join(intentPath, '..'))).includes('pending-migrations.json'), true)
  assert.equal(logs.filter(([level]) => level === 'warn').length, 1, '这条警告只该打一次')

  // 用户随后把那个目录添加成工作区
  world.state.workspaces.push({ id: 'ws-later', path: '<repo>\\not-yet', sessionIds: [] })
  await engine.tick()
  assert.deepEqual(world.state.calls, [['attach', 'ws-later', 's1'], ['detach', 'ws-from', 's1']])
})

test('引擎：dryRun 只记日志，不动任何东西，也不消费意图', async () => {
  const world = fakeWorld()
  const { engine, intentPath, logs, dir } = await makeEngine(world, { dryRun: true })
  await writeFile(intentPath, intentText(['s1']), 'utf8')

  await engine.tick()

  assert.deepEqual(world.state.calls, [])
  assert.equal((await readdir(dir)).includes('pending-migrations.json'), true, 'dryRun 下意图必须还在')
  assert.ok(logs.some(([, message]) => message.includes('dryRun')))
})

test('引擎：坏意图被移到一边，不会每轮重试', async () => {
  const world = fakeWorld()
  const { engine, intentPath, dir, logs } = await makeEngine(world)
  await writeFile(intentPath, '{ broken', 'utf8')

  await engine.tick()
  await engine.tick()

  const files = await readdir(dir)
  assert.equal(files.includes('pending-migrations.json'), false)
  assert.ok(files.some((name) => name.startsWith('invalid-migrations-')), files.join(' / '))
  assert.equal(logs.filter(([level]) => level === 'warn').length, 1, '只该打一次警告')
})

test('引擎：applyMigrations=false 时完全不看意图', async () => {
  const world = fakeWorld()
  const { engine, intentPath, dir } = await makeEngine(world, { applyMigrations: false })
  await writeFile(intentPath, intentText(['s1']), 'utf8')

  await engine.tick()

  assert.deepEqual(world.state.calls, [])
  assert.equal((await readdir(dir)).includes('pending-migrations.json'), true)
})
