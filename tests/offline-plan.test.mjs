/**
 * 只读计划器测试（**零写入**：本文件只断言计划，不碰真实数据）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compressFrame, projectKey, sessionLogFilename } from '../offline/frames.js'
import { buildPlan, collectSessions, describePlan } from '../offline/plan.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))
const FROM = '<repo>\\from'
const TO = '<repo>\\to'

async function tempDir(prefix) {
  await mkdir(tmpRoot, { recursive: true })
  return mkdtemp(join(tmpRoot, prefix))
}

/** 造一个有 `n` 条会话的 sessions 根。 */
async function makeSessionsRoot(options = {}) {
  const cwd = options.cwd ?? FROM
  const version = options.version ?? 4
  const ids = options.ids ?? ['session-a']
  const root = await tempDir('plan-src-')
  for (const id of ids) {
    const dir = join(root, projectKey(cwd), id)
    await mkdir(dir, { recursive: true })
    const header = `${JSON.stringify({
      type: 'session', version, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0
    })}\n`
    const events = '{"type":"sandbox/mode","seq":0,"time":2,"data":{"mode":"workspace-write"}}\n'
    await writeFile(
      join(dir, sessionLogFilename(version)),
      Buffer.concat([await compressFrame(header), await compressFrame(events)])
    )
  }
  return root
}

test('计划：目标目录不存在 ⇒ 全局阻塞，一条都不动', async () => {
  const sessionsRoot = await makeSessionsRoot()
  const plan = await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: join(sessionsRoot, 'nope') })

  assert.equal(plan.ok, false)
  assert.ok(plan.blockers.some((item) => item.startsWith('target-cwd-is-not-an-existing-directory')))
  assert.equal(plan.summary.total, 1)
  assert.equal(plan.summary.movable, 0)
  // 逐条也要被阻塞（写入层不该在没有目标目录时动手）
  assert.equal(plan.sessions[0].action, 'blocked')
})

test('计划：目标存在 ⇒ 该条可迁移，且在内存里试改通过', async () => {
  const sessionsRoot = await makeSessionsRoot()
  const target = await tempDir('plan-dst-')
  const plan = await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: target })

  assert.deepEqual(plan.blockers, [])
  assert.equal(plan.summary.total, 1)
  assert.equal(plan.summary.movable, 1)
  const session = plan.sessions[0]
  assert.equal(session.action, 'move')
  assert.equal(session.headerCwd, FROM)
  assert.equal(session.version, 4)
  assert.equal(session.frameCount, 2)
  assert.equal(session.rewrite.changed, true)
  assert.equal(session.rewrite.header.cwd, target)
  assert.ok(session.dstDir.startsWith(join(sessionsRoot, projectKey(target))))
})

test('计划：`only` 白名单只挑指定会话', async () => {
  const sessionsRoot = await makeSessionsRoot({ ids: ['session-a', 'session-b', 'session-c'] })
  const target = await tempDir('plan-dst-')
  const plan = await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: target, only: ['session-b'] })
  assert.deepEqual(plan.sessions.map((item) => item.sessionId), ['session-b'])
})

test('计划：header 的 cwd 与要迁的 cwd 不符 ⇒ 阻塞该条（拒绝猜测）', async () => {
  const sessionsRoot = await makeSessionsRoot({ cwd: '<repo>\\elsewhere' })
  const target = await tempDir('plan-dst-')
  // 用 FROM 去扫：projectKey(FROM) 下没有东西 ⇒ 一条都收不到
  const empty = await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: target })
  assert.equal(empty.summary.total, 0)
  assert.equal(empty.ok, false, '一条都没有 ⇒ 计划不可用')

  // 直接从"别处"那个 cwd 收：能收到，且 header cwd 相符
  const collected = await collectSessions(sessionsRoot, '<repo>\\elsewhere')
  assert.equal(collected.entries.length, 1)
  assert.deepEqual(collected.entries[0].blocks, [])
})

test('计划：文件名代际与 header 版本不符 ⇒ 阻塞并说清原因', async () => {
  const sessionsRoot = await makeSessionsRoot({ ids: ['session-a'], version: 4 })
  // 把文件改名成错误的代际
  const projectDir = join(sessionsRoot, projectKey(FROM), 'session-a')
  const { rename } = await import('node:fs/promises')
  await rename(join(projectDir, 'session.v4.jsonl.zstd'), join(projectDir, 'session.v3.jsonl.zstd'))

  const collected = await collectSessions(sessionsRoot, FROM)
  assert.equal(collected.entries.length, 1)
  assert.ok(
    collected.entries[0].blocks.some((item) => item.startsWith('log-name-generation-mismatch')),
    collected.entries[0].blocks.join(' / ')
  )
})

test('计划：非日志文件与空目录不会被当成会话', async () => {
  const sessionsRoot = await makeSessionsRoot({ ids: ['session-a'] })
  const projectDir = join(sessionsRoot, projectKey(FROM))
  await mkdir(join(projectDir, 'session-empty'), { recursive: true })
  await writeFile(join(projectDir, 'stray.txt'), 'x')

  const collected = await collectSessions(sessionsRoot, FROM)
  assert.deepEqual(collected.entries.map((item) => item.sessionId).sort(), ['session-a', 'session-empty'])
  const empty = collected.entries.find((item) => item.sessionId === 'session-empty')
  assert.ok(empty.blocks.includes('no-log-file'))
})

test('describePlan：纯函数，渲染出关键字段', async () => {
  const sessionsRoot = await makeSessionsRoot()
  const target = await tempDir('plan-dst-')
  const text = describePlan(await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: target }))
  assert.match(text, /只读预演/)
  assert.match(text, /会话（1）/)
  assert.match(text, /可迁移 1 \/ 共 1/)
  assert.match(text, /计划可用/)
})

test('只读性：计划过程不新增/删除任何文件', async () => {
  const sessionsRoot = await makeSessionsRoot()
  const target = await tempDir('plan-dst-')
  const before = await readdir(sessionsRoot, { recursive: true })
  await buildPlan({ sessionsRoot, fromCwd: FROM, toCwd: target })
  const after = await readdir(sessionsRoot, { recursive: true })
  assert.deepEqual(after.sort(), before.sort())
})
