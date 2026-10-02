/**
 * F002/F003 冒烟测试：插件包骨架的 loader 契约、配置归一化、apply 接线。
 * 运行：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply, Config, inject, isActiveSessionRefusal, name, resolveConfig } from '../src/index.js'

const root = new URL('../', import.meta.url)

/** 一个不产生真实定时器的 ctx 替身。 */
function stubContext(options = {}) {
  const logs = []
  return {
    logs,
    ctx: {
      logger: {
        info: (message) => logs.push(['info', message]),
        warn: (message) => logs.push(['warn', message])
      },
      // 可选 timer 服务：提供它就不会退化出真实的全局 setInterval。
      get: (name) => (name === 'timer' ? { interval: () => ({ dispose() {} }) } : undefined),
      on: () => {},
      workspaceRegistry: {
        list: () => options.workspaces ?? [],
        archiveSession: () => {},
        unarchiveSession: () => {}
      }
    }
  }
}

test('loader 契约：name / inject / Config 形态正确', () => {
  assert.equal(name, 'dsh-plugin-workspace-archive')
  assert.deepEqual(inject, ['workspaceRegistry'])
  assert.equal(typeof Config, 'function', 'Config 必须是 schemastery schema（可调用）')
  assert.equal(typeof apply, 'function')
})

test('Config 空配置可归一化，且默认安全（dryRun）', () => {
  const parsed = Config({})
  assert.equal(parsed.pollIntervalMs, 60000)
  assert.equal(parsed.missingConfirmations, 3)
  assert.equal(parsed.ledgerFile, 'ledger.json')
  assert.equal(parsed.ledgerPath, '')
  assert.equal(parsed.dryRun, true, '默认必须是 dryRun，真机演练前不动数据')
})

test('resolveConfig 拒绝越界值，并接受合法覆盖', () => {
  assert.throws(() => resolveConfig({ pollIntervalMs: 1000 }), /pollIntervalMs/)
  assert.throws(() => resolveConfig({ missingConfirmations: 0 }), /missingConfirmations/)
  assert.throws(() => resolveConfig({ ledgerFile: '' }), /ledgerFile/)
  assert.throws(() => resolveConfig({ dryRun: 'yes' }), /dryRun/)
  assert.deepEqual(resolveConfig({ pollIntervalMs: 30000, missingConfirmations: 2, dryRun: false }), {
    pollIntervalMs: 30000,
    missingConfirmations: 2,
    ledgerFile: 'ledger.json',
    ledgerPath: '',
    dryRun: false
  })
})

test('apply 缺少 workspaceRegistry 时明确报错（不静默装载）', () => {
  assert.throws(() => apply({}, {}), /workspaceRegistry/)
})

test('apply 返回引擎句柄，且 dryRun 下只记日志不动注册表', () => {
  const { ctx, logs } = stubContext({ workspaces: [] })
  const handle = apply(ctx, { ledgerPath: '<repo>\\nonexistent\\ledger.json' })

  assert.equal(typeof handle.engine.tick, 'function')
  assert.equal(handle.ledger.persist, false, 'dryRun 下不落盘')
  assert.ok(logs.some(([, message]) => /已装载/.test(message)))
})

test('isActiveSessionRefusal 按官方错误名/activity 识别「会话仍在跑」', () => {
  const named = Object.assign(new Error('active'), { name: 'WorkspaceActiveSessionError' })
  assert.equal(isActiveSessionRefusal(named), true)
  assert.equal(isActiveSessionRefusal({ activity: [] }), true)
  assert.equal(isActiveSessionRefusal(new Error('other')), false)
  assert.equal(isActiveSessionRefusal(undefined), false)
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
