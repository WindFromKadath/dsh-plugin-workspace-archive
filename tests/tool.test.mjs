/**
 * 工具定义契约测试（F020）—— 用**宿主自己的**校验函数验，而不是靠肉眼看子集。
 *
 * 为什么必须有这一层：`ToolsService.register()` 在注册时就会调 `assertSupportedJsonSchema(output.schema)`，
 * 不合格会**当场抛错**；而 `output.schema` 又是对返回值的**硬校验**，多一个未声明字段整次调用就变成
 * `returned invalid output`。本插件是**手写** `ToolDefinition`（为了不 import `defineTool`、保住零依赖），
 * 所以这两条边界都得由测试守住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  validateJsonSchemaValue
} from '@deepseek-ai/dsh-tools'

import { defineManualTool, renderManualResult } from '../src/index.js'

const engineStub = { manualWorkspace: async () => ({ ok: true }) }
const tool = defineManualTool(engineStub)

test('工具名与必需参数', () => {
  assert.equal(tool.name, 'workspace_archive')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['workspace'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

test('output.schema 与 parameters 都通过宿主自己的 schema 子集校验', () => {
  // register() 注册时调的就是这一个。
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema))
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters))
  // 两处都是 object 根。
  assert.doesNotThrow(() => assertObjectJsonSchema(tool.output.schema))
  assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters))
})

test('execute 可能返回的每一种形状都通过 output.schema', () => {
  const validate = (value) => validateJsonSchemaValue(tool.output.schema, value, '')

  // 成功（归档 / 恢复、dryRun、空计划）
  assert.doesNotThrow(() => validate({
    ok: true, kind: 'archive', path: '<repo>\\proj', title: 'proj',
    requested: 2, skipped: 0, applied: 2, dryRun: false, sessionIds: ['s1', 's2']
  }))
  assert.doesNotThrow(() => validate({
    ok: true, kind: 'unarchive', path: '<repo>\\proj', title: 'proj',
    requested: 0, skipped: 0, applied: 0, dryRun: true, sessionIds: []
  }))
  // 解析失败：not-found / empty-query（无 candidates）
  assert.doesNotThrow(() => validate({ ok: false, reason: 'not-found' }))
  assert.doesNotThrow(() => validate({ ok: false, reason: 'empty-query' }))
  // 解析失败：歧义（带 candidates）
  assert.doesNotThrow(() => validate({
    ok: false,
    reason: 'ambiguous',
    candidates: [{ path: '<repo>\\proj-a', title: 'proj-a' }]
  }))
})

test('render 返回基座认的文本块，且能覆盖所有分支', () => {
  const values = [
    { ok: false, reason: 'ambiguous', candidates: [{ path: 'p', title: 't' }] },
    { ok: false, reason: 'empty-query' },
    { ok: false, reason: 'not-found' },
    { ok: true, kind: 'archive', path: 'p', title: 't', requested: 1, skipped: 0, applied: 1, dryRun: false, sessionIds: ['s'] },
    { ok: true, kind: 'unarchive', path: 'p', title: 't', requested: 1, skipped: 0, applied: 1, dryRun: false, sessionIds: ['s'] },
    { ok: true, kind: 'archive', path: 'p', title: 't', requested: 0, skipped: 0, applied: 0, dryRun: false, sessionIds: [] },
    { ok: true, kind: 'archive', path: 'p', title: 't', requested: 2, skipped: 0, applied: 0, dryRun: true, sessionIds: [] }
  ]
  for (const value of values) {
    const content = tool.output.render({}, value)
    assert.equal(Array.isArray(content), true)
    assert.equal(content.length, 1)
    assert.equal(content[0].type, 'text')
    assert.equal(typeof content[0].text, 'string')
    assert.ok(content[0].text.length > 0)
    assert.equal(content[0].text, renderManualResult(value), 'render 就是 renderManualResult')
  }
})
