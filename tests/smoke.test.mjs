/**
 * F002/F003 冒烟测试：插件包骨架的 loader 契约、配置归一化、apply 接线。
 * 运行：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply, inject, isActiveSessionRefusal, name, resolveConfig, resolveDshHome } from '../src/index.js'

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

test('loader 契约：name / inject 形态正确，且**不导出** schemastery Config', () => {
  assert.equal(name, 'dsh-plugin-workspace-archive')
  assert.deepEqual(inject, ['workspaceRegistry'])
  assert.equal(typeof apply, 'function')
})

test('回归：插件源码不得 import 宿主包（否则 junction 装载会 ERR_MODULE_NOT_FOUND）', () => {
  // 真机教训：profile 里用 junction 指向本仓库时，Node 按真实路径解析嵌套 import，
  // 够不到宿主的 @deepseek-ai/*，插件在 DSH 里直接装载失败（组合正常、模块加载报错）。
  for (const file of ['src/index.js', 'src/ledger.js', 'src/policy.js']) {
    const source = readFileSync(fileURLToPath(new URL(file, root)), 'utf8')
    const bare = source.match(/from\s+'(@?[^.'][^']*)'/g) ?? []
    const external = bare.filter((clause) => /from\s+'(?!node:)/.test(clause))
    assert.deepEqual(external, [], `${file} 只允许 node: 内置模块与相对路径 import`)
  }
})

test('默认配置安全（dryRun），且可由 resolveConfig 归一化', () => {
  const parsed = resolveConfig({})
  assert.equal(parsed.pollIntervalMs, 300000, '轮询只是兜底，主路径是事件驱动')
  assert.equal(parsed.confirmDelayMs, 3000, '时间型确认窗口（毫秒）')
  assert.equal(parsed.watch, true, '默认给工作区目录挂 watcher')
  assert.equal(parsed.ledgerFile, 'ledger.json')
  assert.equal(parsed.ledgerPath, '')
  assert.equal(parsed.dryRun, true, '默认必须是 dryRun，真机演练前不动数据')
})

test('resolveDshHome：优先宿主服务，其次 $DSH_HOME，最后 ~/.dsh', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '<repo>\\tmp-home'
    assert.equal(resolveDshHome(undefined), '<repo>\\tmp-home')
    const ctx = { get: (key) => (key === 'dshHomePath' ? () => '<repo>\\from-ctx' : undefined) }
    assert.equal(resolveDshHome(ctx), '<repo>\\from-ctx')
    delete process.env.DSH_HOME
    assert.match(resolveDshHome(undefined), /\.dsh$/)
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

test('resolveConfig 拒绝越界值，并接受合法覆盖', () => {
  assert.throws(() => resolveConfig({ pollIntervalMs: 500 }), /pollIntervalMs/)
  assert.throws(() => resolveConfig({ confirmDelayMs: -1 }), /confirmDelayMs/)
  assert.throws(() => resolveConfig({ watch: 'yes' }), /watch/)
  assert.throws(() => resolveConfig({ adoptUngrouped: 'yes' }), /adoptUngrouped/)
  assert.throws(() => resolveConfig({ adoptDelayMs: -1 }), /adoptDelayMs/)
  assert.throws(() => resolveConfig({ ledgerFile: '' }), /ledgerFile/)
  assert.throws(() => resolveConfig({ dryRun: 'yes' }), /dryRun/)
  assert.deepEqual(resolveConfig({
    pollIntervalMs: 60000,
    confirmDelayMs: 0,
    watch: false,
    adoptUngrouped: false,
    adoptDelayMs: 0,
    dryRun: false
  }), {
    pollIntervalMs: 60000,
    confirmDelayMs: 0,
    watch: false,
    adoptUngrouped: false,
    adoptDelayMs: 0,
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
