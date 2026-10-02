/**
 * F002 冒烟测试：插件包骨架可被解析、配置可归一化、apply 无副作用。
 * 运行：npm test（等价于 node --import ./test/register.mjs --test tests/）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply, Config, inject, name, resolveConfig } from '../src/index.js'

const root = new URL('../', import.meta.url)

test('loader 契约：name / inject / Config 形态正确', () => {
  assert.equal(name, 'dsh-plugin-workspace-archive')
  assert.deepEqual(inject, ['workspaceRegistry'])
  assert.equal(typeof Config, 'function', 'Config 必须是 schemastery schema（可调用）')
  assert.equal(typeof apply, 'function')
})

test('Config 空配置可归一化，且带出默认值', () => {
  const parsed = Config({})
  assert.equal(parsed.pollIntervalMs, 60000)
  assert.equal(parsed.missingConfirmations, 3)
  assert.equal(parsed.ledgerFile, 'workspace-archive-ledger.json')
  assert.equal(parsed.dryRun, true, '首次真机演练必须是 dryRun')
})

test('resolveConfig 拒绝越界值，并接受合法覆盖', () => {
  assert.throws(() => resolveConfig({ pollIntervalMs: 1000 }), /pollIntervalMs/)
  assert.throws(() => resolveConfig({ missingConfirmations: 0 }), /missingConfirmations/)
  assert.throws(() => resolveConfig({ ledgerFile: '' }), /ledgerFile/)
  assert.throws(() => resolveConfig({ dryRun: 'yes' }), /dryRun/)
  const resolved = resolveConfig({ pollIntervalMs: 30000, missingConfirmations: 2, dryRun: false })
  assert.deepEqual(resolved, {
    pollIntervalMs: 30000,
    missingConfirmations: 2,
    ledgerFile: 'workspace-archive-ledger.json',
    dryRun: false
  })
})

test('apply 只报告就绪：不注册服务、不碰注册表写入', () => {
  const calls = { list: 0, archive: 0, unarchive: 0 }
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(message) },
    workspaceRegistry: {
      list: () => { calls.list++; return [{ id: 'w1' }, { id: 'w2' }] },
      archiveSession: () => { calls.archive++ },
      unarchiveSession: () => { calls.unarchive++ }
    }
  }

  apply(ctx, {})

  assert.equal(logs.length, 1, '骨架只记一行就绪日志')
  assert.match(logs[0], /workspace-archive/)
  assert.match(logs[0], /workspaces=2/)
  assert.equal(calls.archive, 0, '骨架不得归档任何会话')
  assert.equal(calls.unarchive, 0, '骨架不得恢复任何会话')
})

test('apply 在没有 logger / 没有注册表时也不抛错（可测性）', () => {
  assert.doesNotThrow(() => apply({}, {}))
  assert.doesNotThrow(() => apply(undefined, {}) === undefined)
})

test('cordis.patch.yml 声明的行名与本包一致（装载入口自检）', () => {
  const patch = readFileSync(fileURLToPath(new URL('cordis.patch.yml', root)), 'utf8')
  assert.match(patch, /name:\s*dsh-plugin-workspace-archive/)
  assert.match(patch, /id:\s*workspace-archive/)
})

test('package.json 声明 dsh.bundle.patch（DSH 装载的硬条件）', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.main, 'src/index.js')
})
