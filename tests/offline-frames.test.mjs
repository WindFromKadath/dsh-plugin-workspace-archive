/**
 * 离线帧层单测（合成数据，干净克隆上也能跑）。
 *
 * 真数据验证在 `offline-real-fixture.test.mjs`（需要 `.verify/fixtures/`，缺则跳过）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'

import {
  compressFrame,
  encodeSegment,
  firstFrameEnd,
  projectKey,
  readAllText,
  readHeader,
  rewriteHeaderCwd,
  scanFrames,
  sessionLogFilename
} from '../offline/frames.js'

const headerLine = (cwd) => `${JSON.stringify({
  type: 'session',
  version: 4,
  id: 'session-test',
  createdAt: 1,
  cwd,
  isSeeded: false,
  delegationDepth: 0
})}\n`

const EVENTS = '{"type":"permission/preset","seq":0,"time":1,"data":{"preset":"workspace-write"}}\n'
  + '{"type":"sandbox/mode","seq":1,"time":2,"data":{"mode":"workspace-write"}}\n'

async function makeLog(cwd) {
  return Buffer.concat([await compressFrame(headerLine(cwd)), await compressFrame(EVENTS)])
}

test('文件名按代际推导（官方 sessionFormatLogFilename 的规则）', () => {
  assert.equal(sessionLogFilename(0), 'session.jsonl.zstd')
  assert.equal(sessionLogFilename(4), 'session.v4.jsonl.zstd')
  assert.equal(sessionLogFilename(12), 'session.v12.jsonl.zstd')
  assert.throws(() => sessionLogFilename(-1))
})

test('projectKey：分隔符连串只出一个 -，盘符算分隔符', () => {
  assert.equal(projectKey('D:\\work\\proj'), '--D-work-proj--')
  assert.equal(projectKey('/home/u/proj'), '--home-u-proj--')
  assert.equal(projectKey('a//b'), '--a-b--')
  assert.equal(projectKey('a\\\\b'), '--a-b--')
  assert.equal(projectKey('a~b'), '--a~007Eb--')
  assert.throws(() => projectKey(''))
})

test('encodeSegment：可逆转义', () => {
  assert.equal(encodeSegment('session-20897e12-c0c0-4896-81a1-4d571bcf5714'), 'session-20897e12-c0c0-4896-81a1-4d571bcf5714')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.throws(() => encodeSegment(''))
})

test('帧扫描：两帧文件切得开，第一帧边界正确', async () => {
  const log = await makeLog('D:\\work\\proj')
  const { frames, trailing } = scanFrames(log)
  assert.equal(trailing, null)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[0].end, firstFrameEnd(log))
  assert.equal(frames[1].end, log.length)
  // 第 0 帧就是一整行 header
  const text = zstdDecompressSync(log.subarray(0, frames[0].end)).toString('utf8')
  assert.equal(text.split('\n').filter((line) => line.length > 0).length, 1)
})

test('帧 0 逐字节可复现：cwd 不变时重写是恒等变换', async () => {
  const log = await makeLog('D:\\work\\proj')
  const result = await rewriteHeaderCwd(log, 'D:\\work\\proj')
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.ok(result.buffer.equals(log), 'cwd 不变时输出必须与原文件逐字节相同')
})

test('改 cwd：等长替换时整个文件字节数不变，且只有第 0 帧变了', async () => {
  const log = await makeLog('D:\\work\\aaaa')
  const result = await rewriteHeaderCwd(log, 'D:\\work\\bbbb')
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.buffer.length, log.length, '等长 cwd ⇒ 文件总字节数不变')
  assert.equal(result.frame0OriginalBytes, result.frame0RewrittenBytes)

  const before = firstFrameEnd(log)
  const after = firstFrameEnd(result.buffer)
  assert.equal(after, before)
  assert.ok(result.buffer.subarray(after).equals(log.subarray(before)), '第 0 帧之后的字节必须原样保留')

  const header = readHeader(result.buffer)
  assert.equal(header.ok, true)
  assert.equal(header.header.cwd, 'D:\\work\\bbbb')
  assert.equal(header.header.id, 'session-test', '其余字段原样保留')
})

test('改 cwd：变长替换时事件流不变，只有 header 的 cwd 变了', async () => {
  const log = await makeLog('D:\\work\\proj')
  const result = await rewriteHeaderCwd(log, 'D:\\work\\a-much-longer-project')
  assert.equal(result.ok, true)

  const linesBefore = readAllText(log).split('\n').filter((line) => line.length > 0)
  const linesAfter = readAllText(result.buffer).split('\n').filter((line) => line.length > 0)
  assert.equal(linesAfter.length, linesBefore.length)
  assert.deepEqual(linesAfter.slice(1), linesBefore.slice(1), '事件行必须逐字不变')
  assert.equal(JSON.parse(linesAfter[0]).cwd, 'D:\\work\\a-much-longer-project')
})

test('fail-closed：坏输入一律拒绝，不猜', async () => {
  assert.equal((await rewriteHeaderCwd(Buffer.from('not a zstd file'), 'D:\\x')).ok, false)
  assert.equal(readHeader(Buffer.alloc(0)).ok, false)

  // 第 0 帧里有两行 ⇒ 官方启动时会断言失败，我们必须拒绝改写
  const twoLines = Buffer.concat([await compressFrame(`${headerLine('D:\\a')}{"type":"x"}\n`), await compressFrame(EVENTS)])
  assert.deepEqual(await rewriteHeaderCwd(twoLines, 'D:\\b'), { ok: false, reason: 'first-frame-is-not-exactly-one-line (2)' })

  // 不是 session header
  const notHeader = Buffer.concat([await compressFrame('{"type":"something-else"}\n'), await compressFrame(EVENTS)])
  assert.equal((await rewriteHeaderCwd(notHeader, 'D:\\b')).reason, 'first-line-is-not-a-session-header')

  // 没有可用的 cwd
  const noCwd = Buffer.concat([await compressFrame('{"type":"session","version":4}\n'), await compressFrame(EVENTS)])
  assert.equal((await rewriteHeaderCwd(noCwd, 'D:\\b')).reason, 'header-has-no-usable-cwd')

  assert.equal((await rewriteHeaderCwd(await makeLog('D:\\a'), '')).reason, 'new-cwd-must-be-a-non-empty-string')
})
