/**
 * 真 Cordis 装载测试：用真 `@deepseek-ai/cordis` 上下文装载本插件，验证
 * inject 解析、Config 归一化、apply 接线与 dispose 语义（不需要跑 DSH 本体）。
 *
 * 这里提供假的 `timer` 服务，避免真定时器让测试进程不退出；
 * 顺带覆盖「timer 服务存在时走它、不存在时退化」这条可选依赖路径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'
import { scheduleInterval } from '../src/index.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))

async function ledgerPath(name) {
  const dir = await mkdtemp(join(tmpRoot, `${name}-`))
  return join(dir, 'ledger.json')
}

/** 假注册表：记录调用，且不返回任何工作区。 */
function fakeRegistry() {
  const state = { listCalls: 0 }
  return {
    state,
    registry: {
      list() { state.listCalls++; return [] },
      async archiveSession() {},
      async unarchiveSession() {}
    }
  }
}

test('真 Cordis 上下文能装载本插件（inject + Config + apply 全通）', async () => {
  const { registry, state } = fakeRegistry()
  const root = new Context()
  root.provide('workspaceRegistry', registry)
  root.provide('timer', { interval: () => ({ dispose() {} }) })

  await root.plugin(plugin, { dryRun: true, pollIntervalMs: 10000, ledgerPath: await ledgerPath('loader') })
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(state.listCalls >= 1, 'apply 之后应至少跑过一轮对账')
})

test('timer 服务缺失时退化为全局定时器，并在 dispose 时清理', () => {
  const disposed = []
  const ctx = {
    get: () => undefined,
    on: (event, handler) => { if (event === 'dispose') disposed.push(handler) }
  }
  const handle = scheduleInterval(ctx, () => {}, 60000)
  assert.equal(typeof handle, 'object')
  for (const handler of disposed) handler()
  // 清理后不应再有引用（能走到这里即说明没有抛错）
  assert.equal(disposed.length, 1)
})

test('timer 服务存在时使用它（不创建全局定时器）', () => {
  const calls = []
  const ctx = {
    get: (name) => (name === 'timer' ? { interval: (run, ms) => { calls.push([run, ms]); return { dispose() {} } } } : undefined),
    on: () => { throw new Error('不应注册全局 dispose') }
  }
  scheduleInterval(ctx, () => {}, 30000)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 30000)
})
