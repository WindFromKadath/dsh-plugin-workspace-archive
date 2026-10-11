/**
 * 斜杠命令入口（F021）测试。
 *
 * 用**假的命令注册表**捕获定义、直接调 handler —— 验证命令只是"人触发的第二个入口"，
 * 归档/恢复逻辑仍全部走 `engine.manualWorkspace`（不复制）。
 * 真机侧另有一层：`.verify/real-machine.mjs` 用真 `dsh-commands` 断言命令确实注册成功。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COMMANDS, apply, registerCommands } from '../src/index.js'

/** 假命令注册表：只记录 register 进来的定义。 */
function fakeRuntime(options = {}) {
  const registered = []
  return {
    registered,
    register(definition) {
      if (options.failOn === definition.name) throw new Error(`refused: ${definition.name}`)
      registered.push(definition)
      return () => {}
    },
    find: (name) => registered.find((d) => d.name === name)
  }
}

/** 假引擎：记录调用、返回可编排的结果。 */
function fakeEngine(result) {
  const calls = []
  return {
    calls,
    async manualWorkspace(input) {
      calls.push(input)
      return typeof result === 'function' ? result(input) : result
    }
  }
}

const invocation = (rawInput) => ({ rawInput, signal: new AbortController().signal })

test('注册两条命令：归档 / 恢复', () => {
  const runtime = fakeRuntime()
  const engine = fakeEngine({ ok: true })
  const names = registerCommands(runtime, engine, null)

  assert.deepEqual(names, ['archive-workspace', 'restore-workspace'])
  assert.deepEqual(COMMANDS.map((c) => c.name), ['archive-workspace', 'restore-workspace'])
  for (const definition of runtime.registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
    assert.equal(definition.input.hint, '工作区路径或显示标题')
    assert.equal(typeof definition.handler, 'function')
  }
})

test('/archive-workspace 走归档动作，成功映射成 success', async () => {
  const runtime = fakeRuntime()
  const engine = fakeEngine({ ok: true, kind: 'archive', path: 'p', title: 't', requested: 2, skipped: 0, applied: 2, dryRun: false, sessionIds: ['a', 'b'] })
  registerCommands(runtime, engine, null)

  const result = await runtime.find('archive-workspace').handler(invocation('  proj-a  '))

  assert.deepEqual(engine.calls, [{ query: '  proj-a  ', action: 'archive' }], '原样传 rawInput（含分隔空白），由引擎 trim')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已归档 2\/2/)
})

test('/restore-workspace 走恢复动作（对应 F020 的 D015 独立清单）', async () => {
  const runtime = fakeRuntime()
  const engine = fakeEngine({ ok: true, kind: 'unarchive', path: 'p', title: 't', requested: 1, skipped: 0, applied: 1, dryRun: false, sessionIds: ['a'] })
  registerCommands(runtime, engine, null)

  const result = await runtime.find('restore-workspace').handler(invocation('proj-a'))

  assert.deepEqual(engine.calls, [{ query: 'proj-a', action: 'unarchive' }])
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已恢复 1\/1/)
})

test('解析不唯一 → error 结果并列出候选（不猜、不动数据）', async () => {
  const runtime = fakeRuntime()
  const engine = fakeEngine({
    ok: false,
    reason: 'ambiguous',
    candidates: [{ path: '<repo>\\a', title: 'same' }, { path: '<repo>\\b', title: 'same' }]
  })
  registerCommands(runtime, engine, null)

  const result = await runtime.find('archive-workspace').handler(invocation('same'))

  assert.equal(result.kind, 'error')
  assert.equal(typeof result.text, 'string')
  assert.match(result.text, /多个工作区/)
  assert.match(result.text, /<repo>\\a/)
})

test('dryRun 的说明也会回给用户', async () => {
  const runtime = fakeRuntime()
  const engine = fakeEngine({ ok: true, kind: 'archive', path: 'p', title: 't', requested: 1, skipped: 0, applied: 0, dryRun: true, sessionIds: [] })
  registerCommands(runtime, engine, null)

  const result = await runtime.find('archive-workspace').handler(invocation('p'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /dryRun/)
})

test('一条命令注册失败不影响另一条（fail-safe）', () => {
  const runtime = fakeRuntime({ failOn: 'archive-workspace' })
  const engine = fakeEngine({ ok: true })
  const warnings = []

  const names = registerCommands(runtime, engine, { warn: (m) => warnings.push(m) })

  assert.deepEqual(names, ['restore-workspace'], '失败的那条被跳过，另一条照常注册')
  assert.equal(runtime.registered.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /archive-workspace/)
})

test('没有命令服务时安静返回空（不缺服务就崩）', () => {
  const engine = fakeEngine({ ok: true })
  assert.deepEqual(registerCommands(undefined, engine, null), [])
  assert.deepEqual(registerCommands({}, engine, null), [])
  assert.deepEqual(registerCommands({ register: 1 }, engine, null), [])
})

test('回归：apply 真的会把命令注册进 ctx.commands', async () => {
  // 这条是给一个**真发生过的 bug** 立的碑：apply 里当时没有 `logger` 这个局部变量
  // （周围用的是 `ctx?.logger`），`registerCommands(commands, engine, logger)` 求值即抛
  // `ReferenceError`，而它恰好被自己的 try/catch 吞掉 —— 表现是"命令静默没注册"。
  // 77 项离线断言全绿却漏掉它（它们都没让 apply 拿到 commands 服务）；真机装置抓到的。
  const runtime = fakeRuntime()
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    get: (name) => {
      if (name === 'commands') return runtime
      if (name === 'timer') return { interval: () => ({ dispose() {} }) }
      return undefined
    },
    on: () => {},
    effect: () => {},
    workspaceRegistry: { list: () => [], archiveSession: () => {}, unarchiveSession: () => {} }
  }

  assert.doesNotThrow(() => apply(ctx, { dryRun: true, ledgerPath: '<repo>\\nonexistent\\ledger.json' }))
  assert.deepEqual(
    runtime.registered.map((d) => d.name),
    ['archive-workspace', 'restore-workspace']
  )
  assert.deepEqual(logs.filter(([level]) => level === 'warn'), [], '不得出现注册失败告警（含 ReferenceError）')
})
