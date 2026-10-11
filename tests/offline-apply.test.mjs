/**
 * 写入层测试（合成数据；真数据演练在对话里用一次性副本做，不碰用户真实数据）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPlan, rollback, verifyMigration } from '../offline/apply.js'
import { compressFrame, projectKey, readAllText, readHeader, sessionLogFilename } from '../offline/frames.js'
import { buildPlan } from '../offline/plan.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
const FROM = '<repo>\\from'

async function tempDir(prefix) {
  await mkdir(tmpRoot, { recursive: true })
  return mkdtemp(join(tmpRoot, prefix))
}

async function makeSessionsRoot(ids = ['session-a', 'session-b']) {
  const root = await tempDir('apply-src-')
  for (const id of ids) {
    const dir = join(root, projectKey(FROM), id)
    await mkdir(dir, { recursive: true })
    const header = `${JSON.stringify({
      type: 'session', version: 4, id, createdAt: 1, cwd: FROM, isSeeded: false, delegationDepth: 0
    })}\n`
    const events = '{"type":"permission/preset","seq":0,"time":1,"data":{"preset":"workspace-write"}}\n'
      + '{"type":"sandbox/mode","seq":1,"time":2,"data":{"mode":"workspace-write"}}\n'
    await writeFile(
      join(dir, sessionLogFilename(4)),
      Buffer.concat([await compressFrame(header), await compressFrame(events)])
    )
  }
  return root
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function setup() {
  const sessionsRoot = await makeSessionsRoot()
  const target = await tempDir('apply-dst-')
  const backups = await tempDir('apply-bak-')
  const plan = await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: target })
  assert.equal(plan.ok, true)
  return { sessionsRoot, target, backups, plan }
}

test('闸门：没有 confirmed 就不动文件', async () => {
  const { plan, backups } = await setup()
  assert.deepEqual(await applyPlan(plan, { backupRoot: backups }), { ok: false, reason: 'not-confirmed' })
  assert.equal((await applyPlan(plan, { confirmed: true })).reason, 'backup-root-required')
})

test('闸门：计划不可用就拒绝（哪怕 confirmed）', async () => {
  const { plan, backups } = await setup()
  const broken = { ...plan, ok: false }
  const result = await applyPlan(broken, { backupRoot: backups, confirmed: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'plan-not-usable')
})

test('全流程：迁移后目标 header 是新 cwd、事件逐字不变、源已删除', async () => {
  const { plan, backups } = await setup()
  const sources = new Map()
  for (const session of plan.sessions) sources.set(session.sessionId, await readFile(session.srcLog))

  const result = await applyPlan(plan, { backupRoot: backups, confirmed: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.migrated, 2)

  for (const session of plan.sessions) {
    assert.equal(await fileExists(session.srcDir), false, '源目录必须已删除')
    assert.equal(await fileExists(session.dstLog), true, '目标日志必须存在')
    const dst = await readFile(session.dstLog)
    const header = readHeader(dst)
    assert.equal(header.ok, true)
    assert.equal(header.header.cwd, plan.toCwd)
    assert.deepEqual(verifyMigration(sources.get(session.sessionId), dst, plan.toCwd), { ok: true })
  }

  // 备份：改动前的字节必须完好
  for (const entry of JSON.parse(await readFile(join(result.backupDir, 'manifest.json'), 'utf8')).sessions) {
    const backedUp = await readFile(join(entry.backupDir, sessionLogFilename(4)))
    assert.ok(backedUp.equals(sources.get(entry.sessionId)), '备份必须与改动前逐字节相同')
  }
  assert.equal(await fileExists(join(result.backupDir, 'plan.json')), true)
})

test('全流程：rollback 把源放回、把目标删掉，且源逐字节复原', async () => {
  const { plan, backups } = await setup()
  const sources = new Map()
  for (const session of plan.sessions) sources.set(session.sessionId, await readFile(session.srcLog))

  const applied = await applyPlan(plan, { backupRoot: backups, confirmed: true })
  assert.equal(applied.ok, true)

  const reverted = await rollback(applied.backupDir)
  assert.equal(reverted.ok, true, JSON.stringify(reverted))
  assert.equal(reverted.restored, 2)
  for (const session of plan.sessions) {
    assert.equal(await fileExists(session.srcDir), true, '源目录必须回来')
    assert.equal(await fileExists(session.dstDir), false, '目标目录必须删掉')
    const restored = await readFile(session.srcLog)
    assert.ok(restored.equals(sources.get(session.sessionId)), '源必须逐字节复原')
  }
})

test('rollback：源已存在时拒绝，不覆盖（fail-closed）', async () => {
  const { plan, backups } = await setup()
  const applied = await applyPlan(plan, { backupRoot: backups, confirmed: true })
  // 手工把源目录放回来，制造冲突
  await mkdir(plan.sessions[0].srcDir, { recursive: true })
  const result = await rollback(applied.backupDir)
  assert.equal(result.ok, false)
  assert.match(result.reason, /source-already-exists/)
})

test('失败路径：规划之后源被弄坏 ⇒ 报 rewrite-failed 且**源仍在**', async () => {
  const { plan, backups } = await setup()
  // 规划之后把第一个源文件弄成不可解析（模拟"计划与现状不一致"）
  await writeFile(plan.sessions[0].srcLog, Buffer.from('not a zstd file'))
  const result = await applyPlan(plan, { backupRoot: backups, confirmed: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'rewrite-failed')
  assert.equal(await fileExists(plan.sessions[0].srcDir), true, '源必须还在')
  assert.equal(result.migrated.length, 0)
})

test('verifyMigration：目标被动过就必须报出来', async () => {
  const { plan } = await setup()
  const src = await readFile(plan.sessions[0].srcLog)
  const headerOnly = Buffer.concat([await compressFrame('{"type":"session","version":4,"id":"x","cwd":"Z:\\\\z"}\n')])
  assert.equal(verifyMigration(src, headerOnly, plan.toCwd).ok, false)
  // 拿源当目标、又给一个错的期望 cwd ⇒ 必须报 cwd 不匹配
  const mismatched = verifyMigration(src, src, plan.toCwd)
  assert.equal(mismatched.ok, false)
  assert.match(mismatched.reason, /^dst-cwd-mismatch/)
  // 自比自、期望 cwd 正确 ⇒ 通过
  assert.deepEqual(verifyMigration(src, src, FROM), { ok: true })
})

test('迁移意图：apply 写下、rollback 清掉', async () => {
  const { plan, backups } = await setup()
  const intentPath = join(await tempDir('apply-intent-'), 'pending-migrations.json')

  const applied = await applyPlan(plan, { backupRoot: backups, confirmed: true, intentPath })
  assert.equal(applied.ok, true)
  const intent = JSON.parse(await readFile(intentPath, 'utf8'))
  assert.equal(intent.version, 1)
  assert.equal(intent.toCwd, plan.toCwd)
  assert.equal(intent.fromCwd, FROM)
  assert.deepEqual([...intent.sessions].sort(), plan.sessions.map((item) => item.sessionId).sort())
  // 顺序刻意按 createdAt 升序：官方 attachSession 是前插 ⇒ 挂完正好"新的在前"
  const times = plan.sessions.map((item) => item.createdAt ?? 0)
  assert.deepEqual(times, [...times].sort((a, b) => a - b))

  const reverted = await rollback(applied.backupDir)
  assert.equal(reverted.ok, true)
  assert.equal(reverted.clearedIntent, intentPath)
  assert.equal(await fileExists(intentPath), false, '回滚后意图必须清掉，否则插件会把它们挂到目标组')
})

test('迁移意图：没给 intentPath 就不写（可选）', async () => {
  const { plan, backups } = await setup()
  const result = await applyPlan(plan, { backupRoot: backups, confirmed: true })
  assert.equal(result.ok, true)
  assert.equal(result.intentPath, null)
})

test('迁移后源 project 目录下不再有会话（只剩空目录）', async () => {
  const { plan, sessionsRoot } = await setup()
  await applyPlan(plan, { backupRoot: await tempDir('apply-bak-'), confirmed: true })
  const left = await readdir(join(sessionsRoot, projectKey(FROM)))
  assert.deepEqual(left, [], '会话目录都搬走了，只剩空的 project 目录')
  // readAllText 仍能读目标文件
  assert.ok(readAllText(await readFile(plan.sessions[0].dstLog)).length > 0)
})
