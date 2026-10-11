/**
 * 按**单个对话**迁移的测试：定位、标题投影、只给 --session 的规划、目标必须是已登记工作区。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeSessions, listSessions, locateSession, readProjection } from '../offline/catalog.js'
import { compressFrame, projectKey, sessionLogFilename } from '../offline/frames.js'
import { buildPlan, defaultRegistryPath, readRegisteredPaths } from '../offline/plan.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
const FROM = '<repo>\\from'
const TO = '<repo>\\to'

async function tempDir(prefix) {
  await mkdir(tmpRoot, { recursive: true })
  return mkdtemp(join(tmpRoot, prefix))
}

/** 造一个 sessions 根 + 一个 projcache 根 + 一个注册表文件 + 一个**真实存在**的目标目录。 */
async function makeWorld(options = {}) {
  const home = await tempDir('catalog-')
  const sessionsRoot = join(home, 'sessions')
  const target = join(home, 'target')
  await mkdir(target, { recursive: true })
  const projects = options.projects ?? [{ cwd: FROM, ids: ['session-a', 'session-b'] }]
  for (const project of projects) {
    for (const id of project.ids) {
      const dir = join(sessionsRoot, projectKey(project.cwd), id)
      await mkdir(dir, { recursive: true })
      const header = `${JSON.stringify({
        type: 'session', version: 4, id, createdAt: project.createdAt ?? 1,
        cwd: project.cwd, isSeeded: false, delegationDepth: 0
      })}\n`
      const events = '{"type":"sandbox/mode","seq":0,"time":2,"data":{"mode":"workspace-write"}}\n'
      await writeFile(join(dir, sessionLogFilename(4)), Buffer.concat([await compressFrame(header), await compressFrame(events)]))
    }
  }
  const projCacheRoot = join(home, 'storages', 'session_projcache')
  for (const [id, row] of Object.entries(options.projections ?? {})) {
    await mkdir(join(projCacheRoot, 'sessions'), { recursive: true })
    await writeFile(join(projCacheRoot, 'sessions', `${id}.json`), JSON.stringify({
      version: 7,
      record: { identity: { cwd: FROM }, rows: row }
    }), 'utf8')
  }
  if (options.registry !== false) {
    await mkdir(join(home, 'storages'), { recursive: true })
    const paths = [FROM]
    if (options.registerTarget !== false) paths.push(target)
    const rows = {}
    paths.forEach((path, index) => { rows[`ws-${index}`] = { path } })
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: rows } }), 'utf8')
  }
  return { home, sessionsRoot, projCacheRoot, target }
}

test('定位：按 id 找到日志，不存在的返回 null', async () => {
  const { sessionsRoot } = await makeWorld()
  const found = await locateSession(sessionsRoot, 'session-b')
  assert.ok(found !== null)
  assert.equal(found.logFile, 'session.v4.jsonl.zstd')
  assert.ok(found.logPath.endsWith(join('session-b', 'session.v4.jsonl.zstd')))
  assert.equal(await locateSession(sessionsRoot, 'session-nope'), null)
})

test('标题投影：读出官方标题与官方 blank 位；读不到返回 null 而不是崩', async () => {
  const { projCacheRoot } = await makeWorld({
    projections: {
      'session-a': { title: { val: '蓝色大肥鱼' }, sessionListMetadata: { val: { blank: false } } },
      'session-b': { title: { val: '空白' }, sessionListMetadata: { val: { blank: true } } }
    }
  })
  assert.equal((await readProjection(projCacheRoot, 'session-a')).title, '蓝色大肥鱼')
  assert.equal((await readProjection(projCacheRoot, 'session-a')).blank, false)
  assert.equal((await readProjection(projCacheRoot, 'session-b')).blank, true)
  assert.equal(await readProjection(projCacheRoot, 'session-none'), null)
  assert.equal(await readProjection(join(projCacheRoot, 'nope'), 'session-a'), null)
})

test('列清单：只读、按 cwd 过滤、带标题与 blank', async () => {
  const { sessionsRoot, projCacheRoot } = await makeWorld({
    projects: [
      { cwd: FROM, ids: ['session-a', 'session-b'], createdAt: 10 },
      { cwd: TO, ids: ['session-c'], createdAt: 20 }
    ],
    projections: {
      'session-a': { title: { val: '甲' }, sessionListMetadata: { val: { blank: false } } },
      'session-b': { title: { val: '乙' }, sessionListMetadata: { val: { blank: true } } }
    }
  })
  const all = await listSessions({ sessionsRoot, projCacheRoot })
  assert.equal(all.length, 3)
  assert.deepEqual(all.map((item) => item.sessionId), ['session-c', 'session-a', 'session-b'], '按 createdAt 倒序')
  assert.equal(all.find((item) => item.sessionId === 'session-a').title, '甲')
  assert.equal(all.find((item) => item.sessionId === 'session-b').blank, true)

  const onlyFrom = await listSessions({ sessionsRoot, projCacheRoot, cwd: FROM })
  assert.equal(onlyFrom.length, 2)

  const text = describeSessions(all)
  assert.match(text, /甲/)
  assert.match(text, /空白会话/)
})

test('规划：只给 --session 不给 --from ⇒ 源 cwd 由会话自己的 header 解析', async () => {
  const world = await makeWorld()
  const plan = await buildPlan({
    sessionsRoot: world.sessionsRoot, toCwd: world.target, only: ['session-b']
  })
  assert.equal(plan.fromCwd, FROM)
  assert.equal(plan.fromCwdSource, 'session-header')
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers))
  assert.deepEqual(plan.sessions.map((item) => item.sessionId), ['session-b'])
})

test('规划：会话不存在 ⇒ 明确阻塞，不猜', async () => {
  const world = await makeWorld()
  const plan = await buildPlan({ sessionsRoot: world.sessionsRoot, toCwd: world.target, only: ['session-nope'] })
  assert.equal(plan.ok, false)
  assert.ok(plan.blockers.some((item) => item.startsWith('session-not-found')))
})

test('规划：既没 --from 也没唯一 --session ⇒ 明确阻塞', async () => {
  const world = await makeWorld()
  const plan = await buildPlan({ sessionsRoot: world.sessionsRoot, toCwd: world.target })
  assert.ok(plan.blockers.includes('need--from-or-exactly-one--session'))
})

test('守卫：目标**不是已登记的工作区** ⇒ 阻塞（并给可行指引）', async () => {
  const world = await makeWorld({ registerTarget: false })
  const plan = await buildPlan({ sessionsRoot: world.sessionsRoot, fromCwd: FROM, toCwd: world.target })
  assert.equal(plan.targetRegistered, false)
  assert.equal(plan.ok, false)
  assert.ok(plan.blockers.some((item) => item.startsWith('target-cwd-is-not-a-registered-workspace')))
  assert.equal(plan.sessions[0].action, 'blocked', '全局阻塞 ⇒ 逐条也不许说 move')
})

test('守卫：目标是已登记的工作区 ⇒ 放行；注册表读不到 ⇒ 不拦（未知≠不存在）', async () => {
  const registered = await makeWorld()
  const ok = await buildPlan({ sessionsRoot: registered.sessionsRoot, fromCwd: FROM, toCwd: registered.target })
  assert.equal(ok.targetRegistered, true)
  assert.equal(ok.ok, true, JSON.stringify(ok.blockers))

  const unreadable = await makeWorld({ registry: false }) // 不写注册表
  const unknown = await buildPlan({ sessionsRoot: unreadable.sessionsRoot, fromCwd: FROM, toCwd: unreadable.target })
  assert.equal(unknown.targetRegistered, null)
  assert.equal(unknown.ok, true, '读不到注册表不该让工具不能用')
})

test('注册表：路径大小写不敏感（Windows）；defaultRegistryPath 是 sessions 的兄弟目录', async () => {
  const world = await makeWorld()
  const registryPath = defaultRegistryPath(world.sessionsRoot)
  await writeFile(registryPath, JSON.stringify({
    tables: { workspaces: { 'ws-0': { path: FROM.toUpperCase() } } }
  }), 'utf8')
  const paths = await readRegisteredPaths(registryPath)
  assert.equal(paths.has(FROM.toLowerCase()), true)
  assert.equal(registryPath, join(world.home, 'storages', 'workspace.json'))
  assert.equal(await readRegisteredPaths(join(world.home, 'nope.json')), null)
})
