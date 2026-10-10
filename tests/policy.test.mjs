/**
 * 决策层测试（纯函数）：时间型确认窗口、只在确认后归档、恢复只处理台账交集。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProbeState, evaluate } from '../src/policy.js'

/** 极简内存台账替身，接口与 LedgerStore 一致。 */
function fakeLedger(entries = {}) {
  const data = new Map(Object.entries(entries))
  return {
    data,
    entry: (path) => data.get(path.toLowerCase()),
    entries: () => [...data.values()],
    syncHealthy(path, title, sessionIds) {
      const key = path.toLowerCase()
      const previous = data.get(key)
      data.set(key, {
        path,
        title,
        sessionIds: [...sessionIds],
        missingSince: null,
        archivedSessionIds: previous?.archivedSessionIds ?? []
      })
      return data.get(key)
    },
    markMissing(path) {
      const entry = data.get(path.toLowerCase())
      if (entry !== undefined && entry.missingSince === null) entry.missingSince = 'T'
      return entry
    },
    recordArchived(path, sessionIds) {
      const entry = data.get(path.toLowerCase())
      if (entry !== undefined) entry.archivedSessionIds = [...new Set([...entry.archivedSessionIds, ...sessionIds])]
      return entry
    }
  }
}

const observation = (exists, reason) => [
  { path: '<repo>\\proj', title: 'proj', sessionIds: ['s1', 's2'], exists, reason }
]

/** 先健康一轮建立台账条目（真机里目录存在时才记成员）。 */
function seed(ledger) {
  return evaluate({ observations: observation(true), state: createProbeState(), confirmDelayMs: 0, now: 0, ledger }).state
}

test('目录健康：只同步成员，不产生动作', () => {
  const ledger = fakeLedger()
  const { actions } = evaluate({ observations: observation(true), state: createProbeState(), confirmDelayMs: 0, now: 0, ledger })
  assert.deepEqual(actions, [])
  assert.deepEqual(ledger.data.get('<repo>\\proj').sessionIds, ['s1', 's2'])
})

test('时间型确认：第一次看到消失只开始计时，窗口到点才归档', () => {
  const ledger = fakeLedger()
  let state = seed(ledger)

  // t=1000：第一次看到消失 → 只记时间，不动手
  let result = evaluate({ observations: observation(false, 'folder-missing'), state, confirmDelayMs: 3000, now: 1000, ledger })
  assert.deepEqual(result.actions, [])
  state = result.state

  // t=2000：还在窗口内 → 仍不动手
  result = evaluate({ observations: observation(false, 'folder-missing'), state, confirmDelayMs: 3000, now: 2000, ledger })
  assert.deepEqual(result.actions, [])
  state = result.state

  // t=4000：已过 3 秒窗口 → 归档
  result = evaluate({ observations: observation(false, 'folder-missing'), state, confirmDelayMs: 3000, now: 4000, ledger })
  assert.deepEqual(result.actions, [
    { kind: 'archive', path: '<repo>\\proj', sessionIds: ['s1', 's2'], reason: 'folder-missing' }
  ])
})

test('确认窗口内目录回来了：计时清零，不会因旧计时立刻归档', () => {
  const ledger = fakeLedger()
  let state = seed(ledger)
  state = evaluate({ observations: observation(false), state, confirmDelayMs: 3000, now: 1000, ledger }).state
  state = evaluate({ observations: observation(true), state, confirmDelayMs: 3000, now: 1500, ledger }).state
  assert.equal(state.missingSince.size, 0, '回来即清零')

  // 立刻又消失：重新开始计时（2000），t=4500 还不够 3 秒
  const again = evaluate({ observations: observation(false), state, confirmDelayMs: 3000, now: 2000, ledger })
  assert.deepEqual(again.actions, [])
  const early = evaluate({ observations: observation(false), state: again.state, confirmDelayMs: 3000, now: 4500, ledger })
  assert.deepEqual(early.actions, [])
  const late = evaluate({ observations: observation(false), state: again.state, confirmDelayMs: 3000, now: 5100, ledger })
  assert.equal(late.actions.length, 1)
})

test('confirmDelayMs = 0：第二次看到消失即归档（发现即归档）', () => {
  const ledger = fakeLedger()
  let state = seed(ledger)
  state = evaluate({ observations: observation(false), state, confirmDelayMs: 0, now: 0, ledger }).state
  const second = evaluate({ observations: observation(false), state, confirmDelayMs: 0, now: 0, ledger })
  assert.deepEqual(second.actions, [
    { kind: 'archive', path: '<repo>\\proj', sessionIds: ['s1', 's2'], reason: 'folder-missing' }
  ])
})

test('登记被移除（reason=unregistered）同样归档，并带上原因', () => {
  const ledger = fakeLedger()
  let state = seed(ledger)
  state = evaluate({ observations: observation(false, 'unregistered'), state, confirmDelayMs: 0, now: 0, ledger }).state
  const second = evaluate({ observations: observation(false, 'unregistered'), state, confirmDelayMs: 0, now: 0, ledger })
  assert.deepEqual(second.actions, [
    { kind: 'archive', path: '<repo>\\proj', sessionIds: ['s1', 's2'], reason: 'unregistered' }
  ])
})

test('登记被移除 + 本进程见过它登记过 → 立即归档，不等确认窗口', () => {
  const ledger = fakeLedger()
  const state = seed(ledger)
  // 窗口 3 秒，但本进程亲眼见过这条登记 ⇒ 这是用户的明确动作，第一轮就归档。
  // 不等窗口的理由：官方删除登记是即时的，那批会话会立刻散成「无项目」并出现在侧栏。
  const { actions } = evaluate({
    observations: observation(false, 'unregistered'),
    state,
    confirmDelayMs: 3000,
    now: 1000,
    ledger,
    wasRegistered: (path) => path === '<repo>\\proj'
  })
  assert.deepEqual(actions, [
    { kind: 'archive', path: '<repo>\\proj', sessionIds: ['s1', 's2'], reason: 'unregistered' }
  ])
})

test('登记被移除但本进程从未见过（刚启动、注册表还在 bootstrap）→ 保守走确认窗口', () => {
  const ledger = fakeLedger()
  const state = seed(ledger)
  // 反例：没有这条闸门时，"注册表还没铺完"会被当成"登记被删了"直接误归档。
  const first = evaluate({
    observations: observation(false, 'unregistered'),
    state,
    confirmDelayMs: 3000,
    now: 1000,
    ledger,
    wasRegistered: () => false
  })
  assert.deepEqual(first.actions, [], '没见过 → 先只计时，不动手')

  const early = evaluate({
    observations: observation(false, 'unregistered'),
    state: first.state,
    confirmDelayMs: 3000,
    now: 2000,
    ledger,
    wasRegistered: () => false
  })
  assert.deepEqual(early.actions, [], '窗口内不得归档')

  const late = evaluate({
    observations: observation(false, 'unregistered'),
    state: first.state,
    confirmDelayMs: 3000,
    now: 4500,
    ledger,
    wasRegistered: () => false
  })
  assert.equal(late.actions.length, 1, '窗口到点后仍要归档')
})

test('目录缺失（folder-missing）即使本进程见过该登记，也一定走确认窗口', () => {
  const ledger = fakeLedger()
  const state = seed(ledger)
  // stat 会抖（网络盘、改名中途）⇒ 这条判据永远需要时间确认，闸门只对权威事件生效。
  const { actions } = evaluate({
    observations: observation(false, 'folder-missing'),
    state,
    confirmDelayMs: 3000,
    now: 1000,
    ledger,
    wasRegistered: () => true
  })
  assert.deepEqual(actions, [])
})

test('目录回归：只恢复本插件归档过的交集，不碰用户手动归档', () => {
  const ledger = fakeLedger({ '<repo>\\proj': { path: '<repo>\\proj', title: 'proj', sessionIds: [], missingSince: 'T', archivedSessionIds: ['s1'] } })
  const { actions } = evaluate({ observations: observation(true), state: createProbeState(), confirmDelayMs: 0, now: 0, ledger })
  assert.deepEqual(actions, [{ kind: 'unarchive', path: '<repo>\\proj', sessionIds: ['s1'] }])
})

test('从未健康过的目录：没有台账就不动作（不认识那些 id）', () => {
  const ledger = fakeLedger()
  let result = evaluate({ observations: observation(false), state: createProbeState(), confirmDelayMs: 0, now: 0, ledger })
  result = evaluate({ observations: observation(false), state: result.state, confirmDelayMs: 0, now: 10, ledger })
  assert.deepEqual(result.actions, [])
})

test('已归档的会话不会重复归档', () => {
  const ledger = fakeLedger()
  let state = seed(ledger)
  state = evaluate({ observations: observation(false), state, confirmDelayMs: 0, now: 0, ledger }).state
  ledger.recordArchived('<repo>\\proj', ['s1', 's2'])
  const again = evaluate({ observations: observation(false), state, confirmDelayMs: 0, now: 0, ledger })
  assert.deepEqual(again.actions, [])
})
