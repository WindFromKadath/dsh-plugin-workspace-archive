/**
 * T0「无项目 → 按 cwd 归位」的单元断言。
 *
 * 这条功能只走官方只读接口（`sessionPersistence.list()`）+ 官方写接口
 * （`Workspace.attachSession`），判据是**未分组**且 `header.cwd` 规范化后与工作区路径
 * **精确相等** —— 不做前缀匹配、不猜路径、不动归档集合。
 *
 * 夹具一律用**占位符路径**（`<repo>\a` 这种），不写真实盘符：本仓库的隐私约定要求
 * 提交内容里不出现本机绝对路径（工具链的 `absolute-or-user-path` 规则会拦）。
 */

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { adoptUngrouped, selectAdoptions } from '../src/adopt.js'

/** 与 `src/ledger.js` 的 pathKey 同款：resolve 归一（顺带吃掉末尾分隔符）+ Windows 下大小写不敏感。 */
const keyOf = (path) => resolve(path).replaceAll('\\', '/').toLowerCase()

/** 两个工作区路径（占位符）。 */
const W_A = '<repo>\\a'
const W_B = '<repo>\\b'

const workspaces = () => [
  { id: 'w-a', path: W_A, sessionIds: ['s-a'] },
  { id: 'w-b', path: W_B, sessionIds: [] }
]

test('归位：仅「未分组 + cwd 精确等于工作区路径」的会话入选', () => {
  const plan = selectAdoptions({
    workspaces: workspaces(),
    sessions: [
      { id: 's-a', cwd: W_A }, // 已在组里 → 不动
      { id: 's-orphan', cwd: '<REPO>/B/' }, // 未分组 + 命中（大小写/末尾分隔符不敏感）
      { id: 's-elsewhere', cwd: '<repo>\\c' }, // cwd 谁都不等
      { id: 's-nocwd', cwd: undefined } // 没有 cwd
    ],
    keyOf
  })
  assert.deepEqual(plan, [{ workspaceId: 'w-b', path: W_B, sessionIds: ['s-orphan'] }])
})

test('归位：只做精确等值，**父目录/前缀不算命中**', () => {
  const plan = selectAdoptions({
    workspaces: workspaces(),
    sessions: [
      { id: 's-prefix', cwd: '<repo>\\b-extra' },
      { id: 's-parent', cwd: '<repo>' },
      { id: 's-child', cwd: '<repo>\\b\\src' }
    ],
    keyOf
  })
  assert.deepEqual(plan, [], '前缀/父目录/子目录都不得被当作命中')
})

test('归位：同一工作区多条时按 createdAt 升序下发（attachSession 是前插 → 结果才是新的在前）', () => {
  const plan = selectAdoptions({
    workspaces: [{ id: 'w', path: W_B, sessionIds: [] }],
    sessions: [
      { id: 's-new', cwd: W_B, createdAt: 300 },
      { id: 's-old', cwd: W_B, createdAt: 100 },
      { id: 's-mid', cwd: W_B, createdAt: 200 }
    ],
    keyOf
  })
  assert.deepEqual(plan[0].sessionIds, ['s-old', 's-mid', 's-new'])
})

test('adoptUngrouped：dryRun 只记日志，一次 attachSession 都不调', async () => {
  const calls = []
  const logs = []
  const registry = { list: () => workspaces().map((w) => ({ ...w, attachSession: async (id) => calls.push(id) })) }
  const persistence = {
    list: async () => [
      { header: { id: 's-orphan', cwd: W_B } }
    ]
  }
  const adopted = await adoptUngrouped({
    registry,
    persistence,
    dryRun: true,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    realpathFn: async (p) => p,
    keyOf
  })
  assert.deepEqual(adopted, [])
  assert.deepEqual(calls, [])
  assert.ok(logs.some((line) => line.includes('dryRun') && line.includes('s-orphan')), 'dryRun 必须留下可读日志')
})

test('adoptUngrouped：cwd 解析不了（目录已不在）的会话直接跳过，不做无谓尝试', async () => {
  const calls = []
  const registry = {
    list: () => [{ id: 'w', path: W_B, sessionIds: [], attachSession: async (id) => calls.push(id) }]
  }
  const persistence = {
    list: async () => [
      { header: { id: 's-gone', cwd: '<repo>\\gone' } },
      { header: { id: 's-ok', cwd: W_B } }
    ]
  }
  const adopted = await adoptUngrouped({
    registry,
    persistence,
    dryRun: false,
    logger: { info: () => {}, warn: () => {} },
    realpathFn: async (p) => {
      if (p === '<repo>\\gone') throw new Error('ENOENT')
      return p
    },
    keyOf
  })
  assert.deepEqual(adopted, ['s-ok'])
  assert.deepEqual(calls, ['s-ok'], '目录不存在的会话不该被尝试 attach')
})

test('adoptUngrouped：单个会话 attach 失败只记日志，不影响其余会话', async () => {
  const calls = []
  const warns = []
  const registry = {
    list: () => [
      {
        id: 'w',
        path: W_B,
        sessionIds: [],
        attachSession: async (id) => {
          calls.push(id)
          if (id === 's-bad') throw new Error("cannot attach session 's-bad': its cwd resolves elsewhere")
        }
      }
    ]
  }
  const persistence = {
    list: async () => [
      { header: { id: 's-bad', cwd: W_B, createdAt: 1 } },
      { header: { id: 's-good', cwd: W_B, createdAt: 2 } }
    ]
  }
  const adopted = await adoptUngrouped({
    registry,
    persistence,
    dryRun: false,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
    realpathFn: async (p) => p,
    keyOf
  })
  assert.deepEqual(calls, ['s-bad', 's-good'])
  assert.deepEqual(adopted, ['s-good'])
  assert.ok(warns.some((line) => line.includes('s-bad')), '失败必须留日志')
})

test('adoptUngrouped：缺少 persistence 或 registry 时安静地什么都不做', async () => {
  assert.deepEqual(await adoptUngrouped({ registry: undefined, persistence: undefined }), [])
  assert.deepEqual(await adoptUngrouped({ registry: { list: () => [] }, persistence: undefined }), [])
})
