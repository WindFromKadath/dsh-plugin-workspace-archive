/**
 * 手动归档工作区（F020）决策层测试：解析不猜、只碰"官方尚未归档"的会话、
 * 恢复只动我们自己的清单。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planManual, resolveWorkspace } from '../src/manual.js'
import { renderManualResult } from '../src/index.js'

const A = { id: 'ws-a', path: '<repo>\\proj-a', title: 'proj-a', sessionIds: ['s1', 's2'] }
const B = { id: 'ws-b', path: '<repo>\\proj-b', title: 'proj-b', sessionIds: ['s3'] }
const SAME_TITLE = { id: 'ws-c', path: '<repo>\\proj-c', title: 'proj-a', sessionIds: [] }

test('解析：按路径精确命中（路径优先于标题）', () => {
  const result = resolveWorkspace([A, B], '<repo>\\proj-b')
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'ws-b')
})

test('解析：按标题命中', () => {
  const result = resolveWorkspace([A, B], 'proj-b')
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'ws-b')
})

test('解析：标题撞车 → 拒绝并列候选，绝不猜', () => {
  const result = resolveWorkspace([A, SAME_TITLE], 'proj-a')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ambiguous')
  assert.deepEqual(result.candidates, [
    { path: '<repo>\\proj-a', title: 'proj-a' },
    { path: '<repo>\\proj-c', title: 'proj-a' }
  ])
})

test('解析：找不到 / 空查询', () => {
  assert.deepEqual(resolveWorkspace([A], '<repo>\\nope'), { ok: false, reason: 'not-found' })
  assert.deepEqual(resolveWorkspace([A], '   '), { ok: false, reason: 'empty-query' })
})

test('计划归档：跳过官方已归档的（可能是用户自己归档的）', () => {
  const plan = planManual({
    workspace: A,
    alreadyArchived: new Set(['s2']),
    entry: undefined,
    action: 'archive'
  })
  assert.deepEqual(plan, { kind: 'archive', sessionIds: ['s1'], skipped: ['s2'] })
})

test('计划归档：已在我们的手动清单里的不重复收', () => {
  const plan = planManual({
    workspace: A,
    alreadyArchived: new Set(),
    entry: { manualArchivedSessionIds: ['s1'] },
    action: 'archive'
  })
  assert.deepEqual(plan, { kind: 'archive', sessionIds: ['s2'], skipped: ['s1'] })
})

test('计划归档：成员为空就是空计划', () => {
  const plan = planManual({
    workspace: { ...A, sessionIds: [] },
    alreadyArchived: new Set(),
    entry: undefined,
    action: 'archive'
  })
  assert.deepEqual(plan, { kind: 'archive', sessionIds: [], skipped: [] })
})

test('计划恢复：只取本工具的手动清单，不按当前成员表过滤', () => {
  const plan = planManual({
    workspace: { ...A, sessionIds: [] }, // 会话可能已经离开分组
    alreadyArchived: new Set(['s1', 's2']),
    entry: { manualArchivedSessionIds: ['s1', 's2'] },
    action: 'unarchive'
  })
  assert.deepEqual(plan, { kind: 'unarchive', sessionIds: ['s1', 's2'], skipped: [] })
})

test('计划恢复：没有手动清单就是空计划（不会误放自动归档的）', () => {
  const plan = planManual({
    workspace: A,
    alreadyArchived: new Set(['s1']),
    entry: { archivedSessionIds: ['s1'] }, // 自动归档的，不归手动恢复管
    action: 'unarchive'
  })
  assert.deepEqual(plan, { kind: 'unarchive', sessionIds: [], skipped: [] })
})

test('render：歧义时列出候选，dryRun / 空计划各有说明', () => {
  const ambiguous = renderManualResult({
    ok: false,
    reason: 'ambiguous',
    candidates: [{ path: '<repo>\\proj-a', title: 'proj-a' }]
  })
  assert.match(ambiguous, /多个工作区/)
  assert.match(ambiguous, /proj-a/)

  assert.match(renderManualResult({ ok: false, reason: 'not-found' }), /没有找到/)

  assert.match(
    renderManualResult({ ok: true, kind: 'archive', path: 'p', title: 't', requested: 2, dryRun: true }),
    /dryRun/
  )
  assert.match(
    renderManualResult({ ok: true, kind: 'archive', path: 'p', title: 't', requested: 0, skipped: 0, dryRun: false }),
    /没有需要归档/
  )
  assert.match(
    renderManualResult({ ok: true, kind: 'archive', path: 'p', title: 't', requested: 3, applied: 2, skipped: 1, dryRun: false }),
    /已归档 2\/3/
  )
})
