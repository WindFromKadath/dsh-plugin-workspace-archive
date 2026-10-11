/**
 * 仓库产物守卫：`tasks.csv` 的结构。
 *
 * 为什么要测：这张表用**逗号分列**，而 evidence 字段里全是代码、类型和源码路径 ——
 * 随手写成 `Record<string, unknown>` 或 `logPath(root, meta.cwd, meta.id, …)` 就会多切出一列，
 * 把后面的 `status` / `verified_revision` / `verified_at` 全部**静默错位**（`Import-Csv` 不报错）。
 *
 * 这个错**本仓库犯过两次**（F020 与 F023），所以立成回归。
 *
 * 约定：**字段内不得出现 ASCII 逗号**；需要停顿用全角 `，` 或 `；`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const text = readFileSync(fileURLToPath(new URL('tasks.csv', root)), 'utf8')
const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)

const HEADER = ['id', 'goal', 'acceptance', 'scope', 'status', 'evidence', 'verified_revision', 'verified_at']
/** 状态只有这四档 + 计划中（见 AGENTS.md 的纪律）。 */
const STATUSES = new Set(['todo', 'doing', 'planning', 'blocked', 'done'])

test('tasks.csv：表头固定 8 列', () => {
  assert.deepEqual(lines[0].split(','), HEADER)
})

test('tasks.csv：每行恰好 8 列（字段内不得出现 ASCII 逗号）', () => {
  const bad = []
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split(',')
    if (fields.length !== HEADER.length) {
      bad.push({ 行号: index + 2, id: fields[0], 实测列数: fields.length })
    }
  }
  assert.deepEqual(bad, [], '每行必须 8 列；多出来的列通常是 evidence 里写了 ASCII 逗号')
})

test('tasks.csv：id 形如 Fnnn、升序且唯一；status 取值合法', () => {
  const ids = []
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split(',')
    const rowNumber = index + 2
    assert.match(fields[0], /^F\d{3}$/, `第 ${rowNumber} 行 id 不合规：${fields[0]}`)
    assert.ok(STATUSES.has(fields[4]), `第 ${rowNumber} 行 status 不合法：${fields[4]}`)
    ids.push(fields[0])
  }
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复')
  assert.deepEqual(ids, [...ids].sort(), 'id 应保持升序')
})
