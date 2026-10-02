/**
 * 决策层测试（纯函数）：去抖、只在确认缺失后归档、恢复只处理台账交集。
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

const observation = (exists) => [{ path: '<repo>\\proj', title: 'proj', sessionIds: ['s1', 's2'], exists }]

test('目录健康：只同步成员，不产生动作', () => {
  const ledger = fakeLedger()
  const { actions } = evaluate({ observations: observation(true), state: createProbeState(), confirmations: 3, ledger })
  assert.deepEqual(actions, [])
  assert.deepEqual(ledger.data.get('<repo>\\proj').sessionIds, ['s1', 's2'])
})

test('缺失要连续达到确认次数才归档（去抖）', () => {
  const ledger = fakeLedger()
  let state = createProbeState()
  // 先健康一轮建立台账条目（真机里目录存在时才记成员）。
  state = evaluate({ observations: observation(true), state, confirmations: 3, ledger }).state
  for (const expected of [[], []]) {
    const result = evaluate({ observations: observation(false), state, confirmations: 3, ledger })
    assert.deepEqual(result.actions, expected)
    state = result.state
  }
  const third = evaluate({ observations: observation(false), state, confirmations: 3, ledger })
  assert.deepEqual(third.actions, [{ kind: 'archive', path: '<repo>\\proj', sessionIds: ['s1', 's2'], reason: 'folder-missing' }])
})

test('缺失后恢复健康：重新达到确认次数才再次归档（去抖要复位）', () => {
  const ledger = fakeLedger()
  let state = createProbeState()
  // 先健康一轮：台账条目只会在健康时建立（真机同样如此）。
  state = evaluate({ observations: observation(true), state, confirmations: 3, ledger }).state
  for (let i = 0; i < 3; i++) {
    state = evaluate({ observations: observation(false), state, confirmations: 3, ledger }).state
  }
  ledger.recordArchived('<repo>\\proj', ['s1', 's2'])
  // 目录回来一次 → 恢复动作 + 去抖归零
  const back = evaluate({ observations: observation(true), state, confirmations: 3, ledger })
  assert.deepEqual(back.actions, [{ kind: 'unarchive', path: '<repo>\\proj', sessionIds: ['s1', 's2'] }])
  // 马上又消失一次：不应立刻归档
  const gone = evaluate({ observations: observation(false), state: back.state, confirmations: 3, ledger })
  assert.deepEqual(gone.actions, [])
})

test('目录回归：只恢复本插件归档过的交集，不碰用户手动归档', () => {
  const ledger = fakeLedger({ '<repo>\\proj': { path: '<repo>\\proj', title: 'proj', sessionIds: [], missingSince: 'T', archivedSessionIds: ['s1'] } })
  const { actions } = evaluate({ observations: observation(true), state: createProbeState(), confirmations: 3, ledger })
  assert.deepEqual(actions, [{ kind: 'unarchive', path: '<repo>\\proj', sessionIds: ['s1'] }])
})

test('从未健康过的目录：没有台账就不动作（不认识那些 id）', () => {
  const ledger = fakeLedger()
  const { actions } = evaluate({ observations: observation(false), state: createProbeState(), confirmations: 1, ledger })
  assert.deepEqual(actions, [])
})

test('已归档的会话不会重复归档', () => {
  const ledger = fakeLedger()
  let state = createProbeState()
  state = evaluate({ observations: observation(true), state, confirmations: 3, ledger }).state
  for (let i = 0; i < 3; i++) {
    state = evaluate({ observations: observation(false), state, confirmations: 3, ledger }).state
  }
  ledger.recordArchived('<repo>\\proj', ['s1', 's2'])
  const again = evaluate({ observations: observation(false), state, confirmations: 3, ledger })
  assert.deepEqual(again.actions, [])
})
