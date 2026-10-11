/**
 * 离线帧层 · **真实会话**验证。
 *
 * 夹具由 `.verify/fixture-real-sessions.mjs` 从用户的真实 `~/.dsh/sessions/` **复制**而来
 * （源目录只读），落在 `.verify/fixtures/`（gitignore，干净克隆上不存在 ⇒ 本文件整体跳过）。
 *
 * 这一层才是关键的：它用真数据验证两条我们无法自证的假设 ——
 *   ① `projectKey(header.cwd)` 必须**正好等于**官方目录名；
 *   ② 用我们发现的参数（流式 + windowLog 21 + checksum）重压第 0 帧必须**逐字节相同**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  firstFrameEnd,
  projectKey,
  readAllText,
  readHeader,
  rewriteHeaderCwd,
  scanFrames,
  sessionLogFilename
} from '../offline/frames.js'

const fixtureRoot = fileURLToPath(new URL('../.verify/fixtures/', import.meta.url))
let sessions = []
try {
  for (const slug of readdirSync(fixtureRoot)) {
    const slugDir = join(fixtureRoot, slug)
    if (statSync(slugDir).isDirectory() === false) continue
    for (const sessionId of readdirSync(slugDir)) {
      const sessionDir = join(slugDir, sessionId)
      if (statSync(sessionDir).isDirectory() === false) continue
      for (const file of readdirSync(sessionDir)) {
        if (file.endsWith('.zstd') === false) continue
        sessions.push({ slug, sessionId, file, path: join(sessionDir, file) })
      }
    }
  }
} catch {
  sessions = []
}

const skip = sessions.length === 0
  ? '没有 `.verify/fixtures/` 夹具：先跑 `node .verify/fixture-real-sessions.mjs`'
  : false

test('真实夹具：数量与目录结构', { skip }, () => {
  assert.ok(sessions.length > 0)
  // 夹具目录名必须与 projectKey(cwd) 一致 —— 这条在下面逐条断言
})

if (skip === false) {
  for (const session of sessions) {
    test(`真实会话 ${session.sessionId.slice(0, 18)}…：帧结构与官方目录名一致`, () => {
      const buffer = readFileSync(session.path)
      const header = readHeader(buffer)
      assert.equal(header.ok, true, `第 0 帧应可读：${header.reason ?? ''}`)

      // ① 目录名 = projectKey(cwd)：验证我们抄的算法与官方逐字节一致
      assert.equal(projectKey(header.header.cwd), session.slug)

      // ② 文件名按代际推导，与官方写的名字一致
      assert.equal(sessionLogFilename(header.header.version), session.file)

      const { frames, trailing } = scanFrames(buffer)
      assert.equal(trailing, null, '夹具应是完整文件，没有残尾')
      assert.ok(frames.length >= 2, '至少要有 header 帧 + 事件帧')
      assert.equal(firstFrameEnd(buffer), frames[0].end)
    })

    test(`真实会话 ${session.sessionId.slice(0, 18)}…：第 0 帧逐字节可复现`, async () => {
      const buffer = readFileSync(session.path)
      const header = readHeader(buffer)
      const result = await rewriteHeaderCwd(buffer, header.header.cwd)
      assert.equal(result.ok, true)
      assert.equal(result.changed, false)
      assert.ok(
        result.buffer.equals(buffer),
        'cwd 不变时重压出的第 0 帧必须与原文件逐字节相同（证明官方参数猜对了）'
      )
    })

    test(`真实会话 ${session.sessionId.slice(0, 18)}…：改 cwd 后事件流逐字不变`, async () => {
      const buffer = readFileSync(session.path)
      const header = readHeader(buffer)
      const oldCwd = header.header.cwd
      const newCwd = oldCwd.endsWith('-moved') ? oldCwd : `${oldCwd}-moved`

      const result = await rewriteHeaderCwd(buffer, newCwd)
      assert.equal(result.ok, true)

      // 第 0 帧之后的字节必须原样
      const beforeEnd = firstFrameEnd(buffer)
      const afterEnd = firstFrameEnd(result.buffer)
      assert.ok(result.buffer.subarray(afterEnd).equals(buffer.subarray(beforeEnd)))

      // 事件行逐字不变
      const linesBefore = readAllText(buffer).split('\n').filter((line) => line.length > 0)
      const linesAfter = readAllText(result.buffer).split('\n').filter((line) => line.length > 0)
      assert.equal(linesAfter.length, linesBefore.length)
      assert.deepEqual(linesAfter.slice(1), linesBefore.slice(1))

      const rewritten = JSON.parse(linesAfter[0])
      assert.equal(rewritten.cwd, newCwd)
      assert.equal(rewritten.id, header.header.id)
      assert.equal(rewritten.version, header.header.version)
      assert.equal(rewritten.createdAt, header.header.createdAt)
      // 帧数不变
      assert.equal(scanFrames(result.buffer).frames.length, scanFrames(buffer).frames.length)
    })
  }
}
