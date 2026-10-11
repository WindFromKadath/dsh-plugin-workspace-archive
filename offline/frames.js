/**
 * 离线迁移引擎 · 帧层（F022 / B 共用）。
 *
 * 纯函数为主：Buffer 进 Buffer 出，不碰文件系统 —— 所以能离线单测。
 *
 * ## 为什么只需要动第 0 帧
 *
 * 官方把 session header **单独放在第一个 zstd 帧**里。实测（2026-10-11，用户真实会话
 * `session.v4.jsonl.zstd`，325 字节）：**帧 0 = 178 字节，就是 header 那一行**；
 * 帧 1 = 147 字节，是 3 条事件。所以"改 cwd" ＝ 只重压第 0 帧，**其余帧字节原样保留**。
 *
 * ## 帧参数（实测逐字节复现过）
 *
 * 官方写入端是**流式** zstd，`ZSTD_c_windowLog: 21` + `ZSTD_c_checksumFlag: 1`、默认 level。
 * 用一次性 `zstdCompressSync` 得不到同样的字节 —— 它的窗口描述符是 `0x00`（windowLog=10），
 * 而官方是 `0x58`（windowLog=21）。必须走 `createZstdCompress` 流式，才能：
 *
 *   wlog21+cks1 → 178 字节，与原帧**逐字节相同**
 *
 * 这条很值钱：改完之后如果新 cwd 与旧 cwd **等长**，整个文件的字节数都不变。
 *
 * ## 出处
 *
 * - `projectKey` / `encodeSegment`：照抄官方 `dsh-session-persistence-jsonl/lib/index.js:853-894`。
 * - 日志文件名代际：官方 `dsh-session-format/lib/index.js:472-475`（0 → `session.jsonl`，
 *   N → `session.vN.jsonl`），压缩后缀另加 `.zstd`。
 *
 * ⚠️ 本模块**不做任何写操作**，也不读文件 —— 落盘、备份、搬目录、预检都在上层。
 *
 * @module dsh-plugin-workspace-archive/offline/frames
 */

import { constants, createZstdCompress, zstdDecompressSync } from 'node:zlib'
import { open } from 'node:fs/promises'

/** zstd 帧 magic。 */
export const ZSTD_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 官方写入端的 zstd 参数。**不要改**：改了就不再逐字节可复现，重写出来的帧虽然仍合法，
 * 但我们失去了"新 cwd 等长 ⇒ 文件字节数不变"这个强性质。
 */
export const OFFICIAL_ZSTD_PARAMS = Object.freeze({
  [constants.ZSTD_c_windowLog]: 21,
  [constants.ZSTD_c_checksumFlag]: 1
})

/** 压缩后缀。官方 `compressionSuffix(compression)` 在本机配置下就是 `.zstd`。 */
export const COMPRESSION_SUFFIX = '.zstd'

/**
 * 官方 `sessionFormatLogFilename`：按**代际**推导日志基名（0 是一代特例）。
 * @param version - header 里的 `version`。
 * @returns 不带压缩后缀的基名。
 */
export function sessionLogBasename(version) {
  if (Number.isSafeInteger(version) === false || version < 0) {
    throw new Error(`workspace-archive: 非法代际 ${String(version)}`)
  }
  return version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
}

/**
 * 一个会话目录下的日志文件名（含压缩后缀）。
 * @param version - header 里的 `version`。
 * @returns 文件名，例如 `session.v4.jsonl.zstd`。
 */
export function sessionLogFilename(version) {
  return `${sessionLogBasename(version)}${COMPRESSION_SUFFIX}`
}

/**
 * 官方 `encodeSegment`：把任意字符串编成一个可逆的路径段。
 * @param raw - 非空字符串。
 * @returns 转义后的单个路径段。
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 官方 `projectKey`：把 cwd 编成 `sessions/` 下那个人类可读的项目目录名。
 *
 * 注意三处细节，抄错一个字就会找不到目录：① 分隔符 `/ \ :` 的**连续串**只产生一个 `-`；
 * ② 结果先去掉开头的 `-` 串、空则用 `root`，**截断到 251**，再包 `--…--`；③ `~` 也要转义。
 * @param cwd - 会话的 cwd。
 * @returns 类似 `--D-Coding-PersonalAction-Rust--`。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index++) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (separatorRun === false) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 找出所有 magic 位置。 */
function magicPositions(buffer) {
  const positions = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (
      buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]
    ) positions.push(index)
  }
  return positions
}

/**
 * 逐帧切开。magic 有可能**恰好出现在压缩数据里**，所以每个候选边界都要真的解一次压才算数；
 * 解不开就把下一个候选起点吞进来重试。
 * @param buffer - 整个日志文件。
 * @returns `{ frames, trailing }`；`frames` 是 `{start,end}`，`trailing` 是尾部无法解压的字节区间（残尾）。
 */
export function scanFrames(buffer) {
  const positions = magicPositions(buffer)
  if (positions.length === 0 || positions[0] !== 0) {
    return { frames: [], trailing: buffer.length > 0 ? { start: 0, end: buffer.length } : null }
  }
  const frames = []
  let begin = 0
  while (begin < positions.length) {
    let end = begin + 1
    let stop = null
    while (end <= positions.length) {
      const candidateStop = end < positions.length ? positions[end] : buffer.length
      try {
        zstdDecompressSync(buffer.subarray(positions[begin], candidateStop))
        stop = candidateStop
        break
      } catch {
        end += 1
      }
    }
    if (stop === null) {
      // 从这里往后都解不开 ⇒ 残尾。
      return { frames, trailing: { start: positions[begin], end: buffer.length } }
    }
    frames.push({ start: positions[begin], end: stop })
    begin = end
  }
  return { frames, trailing: null }
}

/**
 * 第 0 帧的结束位置。我们只需要这一个边界 —— 因为它之后的所有字节都会被**原样保留**。
 * @param buffer - 整个日志文件。
 * @returns 结束偏移；`-1` 表示第 0 帧读不出来（交给调用方 fail-closed）。
 */
export function firstFrameEnd(buffer) {
  const positions = magicPositions(buffer)
  if (positions.length === 0 || positions[0] !== 0) return -1
  for (let index = 1; index <= positions.length; index++) {
    const stop = index < positions.length ? positions[index] : buffer.length
    try {
      zstdDecompressSync(buffer.subarray(0, stop))
      return stop
    } catch { /* 这个候选是数据里碰巧出现的 magic，试下一个 */ }
  }
  return -1
}

/**
 * 用**官方参数**把一段文本压成单个 zstd 帧。
 *
 * 必须流式（见模块头注释）：一次性 API 的窗口描述符与官方不同，就不再逐字节可复现。
 * @param text - 要压的文本（header 帧含结尾换行）。
 * @returns 帧字节。
 */
export function compressFrame(text) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = createZstdCompress({ params: { ...OFFICIAL_ZSTD_PARAMS } })
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.end(Buffer.from(text, 'utf8'))
  })
}

/**
 * 读第 0 帧里的 header。
 * @param buffer - 整个日志文件。
 * @returns `{ ok: true, header, text, frameEnd }` 或 `{ ok: false, reason }`。
 */
export function readHeader(buffer) {
  const frameEnd = firstFrameEnd(buffer)
  if (frameEnd < 0) return { ok: false, reason: 'first-frame-unreadable' }
  let text
  try {
    text = zstdDecompressSync(buffer.subarray(0, frameEnd)).toString('utf8')
  } catch (error) {
    return { ok: false, reason: `first-frame-decompress-failed: ${String(error)}` }
  }
  const lines = text.split('\n').filter((line) => line.length > 0)
  if (lines.length !== 1) return { ok: false, reason: `first-frame-is-not-exactly-one-line (${lines.length})` }
  let header
  try {
    header = JSON.parse(lines[0])
  } catch (error) {
    return { ok: false, reason: `first-line-is-not-json: ${String(error)}` }
  }
  if (header?.type !== 'session') return { ok: false, reason: 'first-line-is-not-a-session-header' }
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) return { ok: false, reason: 'header-has-no-usable-cwd' }
  return { ok: true, header, text, frameEnd }
}

/**
 * 只重写第 0 帧里的 `cwd`，其余帧**字节不动**。
 *
 * 做法是**在 JSON 文本里做定点替换**（而不是重新序列化 header）—— 这样键顺序、空白、
 * 以及未来新增的字段都原样保留，我们只碰那一个值。
 *
 * 内置三重自检，任何一条不过就 fail-closed：
 *   ① 替换后的文本能解析、且 `cwd` 正好是新值；
 *   ② 重压出来的帧能独立解回那一行；
 *   ③ 第 0 帧仍然**只有一行**（官方启动时会断言这件事，塌缩就起不来）。
 *
 * @param buffer - 原始日志文件字节。
 * @param newCwd - 新的 cwd。
 * @returns `{ ok: true, buffer, header, oldCwd, changed }` 或 `{ ok: false, reason }`。
 */
export async function rewriteHeaderCwd(buffer, newCwd) {
  if (typeof newCwd !== 'string' || newCwd.length === 0) return { ok: false, reason: 'new-cwd-must-be-a-non-empty-string' }
  const read = readHeader(buffer)
  if (read.ok !== true) return read

  const { header, text, frameEnd } = read
  if (header.cwd === newCwd) {
    return { ok: true, buffer, header, oldCwd: header.cwd, changed: false }
  }

  const line = text.slice(0, text.length - (text.endsWith('\n') ? 1 : 0))
  const quotedOld = JSON.stringify(header.cwd)
  const at = line.indexOf(quotedOld)
  if (at < 0) return { ok: false, reason: 'cwd-value-not-found-in-header-text' }

  const rewrittenLine = `${line.slice(0, at)}${JSON.stringify(newCwd)}${line.slice(at + quotedOld.length)}\n`

  // 自检 ①：替换后的文本必须能解析、且 cwd 正好是新值。
  let reparsed
  try {
    reparsed = JSON.parse(rewrittenLine)
  } catch (error) {
    return { ok: false, reason: `rewritten-header-is-not-json: ${String(error)}` }
  }
  if (reparsed?.cwd !== newCwd) return { ok: false, reason: 'rewritten-header-cwd-mismatch' }

  const frame0 = await compressFrame(rewrittenLine)
  const out = Buffer.concat([frame0, buffer.subarray(frameEnd)])

  // 自检 ②：重压出来的帧要能独立解回那一行；自检 ③：仍然只有一行。
  let verifyText
  try {
    verifyText = zstdDecompressSync(out.subarray(0, frame0.length)).toString('utf8')
  } catch (error) {
    return { ok: false, reason: `rewritten-frame-does-not-decompress: ${String(error)}` }
  }
  if (verifyText !== rewrittenLine) return { ok: false, reason: 'rewritten-frame-round-trip-mismatch' }

  return {
    ok: true,
    buffer: out,
    header: reparsed,
    oldCwd: header.cwd,
    changed: true,
    frame0OriginalBytes: frameEnd,
    frame0RewrittenBytes: frame0.length
  }
}

/**
 * 只读日志**开头**若干字节来拿 header —— 避免为了读一行 header 把整份日志读进内存。
 *
 * 第 0 帧是一个独立的 zstd 帧，所以只要它整个落在前缀里就能完整解出来；超出前缀
 * （极罕见：cwd 长到几千字节）时返回 `header-exceeds-prefix`，交给调用方决定要不要整份读。
 * @param logPath - 日志文件路径。
 * @param maxBytes - 最多读多少字节（默认 64 KiB）。
 * @returns 与 `readHeader` 同形。
 */
export async function readHeaderPrefix(logPath, maxBytes = 65536) {
  let handle
  try {
    handle = await open(logPath, 'r')
  } catch (error) {
    return { ok: false, reason: `open-failed: ${String(error)}` }
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const prefix = buffer.subarray(0, bytesRead)
    const frameEnd = firstFrameEnd(prefix)
    if (frameEnd < 0) return { ok: false, reason: 'header-exceeds-prefix' }
    return readHeader(prefix.subarray(0, frameEnd))
  } catch (error) {
    return { ok: false, reason: `prefix-read-failed: ${String(error)}` }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 把整个文件解成文本（用于"改完之后事件流必须一模一样"的校验）。
 * @param buffer - 整个日志文件。
 * @returns 文本；任一处坏掉返回 `undefined`（fail-closed）。
 */
export function readAllText(buffer) {
  const { frames, trailing } = scanFrames(buffer)
  if (trailing !== null) return void 0
  let text = ''
  for (const frame of frames) {
    try {
      text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      return void 0
    }
  }
  return text
}
