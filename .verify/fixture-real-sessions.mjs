/**
 * 把用户**真实**的会话日志复制成离线测试夹具（源目录**只读**，只 copy 不改）。
 *
 * 用途：让我们能拿真数据验证"帧 0 逐字节可复现重压"和"projectKey 与官方目录名一致"，
 * 而不是只跟自己做自洽测试。
 *
 * 夹具落在 `.verify/fixtures/`（已 gitignore）⇒ 干净克隆上不存在，相关测试会自动跳过。
 *
 * 用法：
 *   node .verify/fixture-real-sessions.mjs [匹配工作区 slug 的子串，默认 Rust]
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const needle = (process.argv[2] ?? 'Rust').toLowerCase()
const source = join(homedir(), '.dsh', 'sessions')
const dest = join(root, '.verify', 'fixtures')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

let copied = 0
for (const slug of await readdir(source)) {
  if (slug.toLowerCase().includes(needle) === false) continue
  const slugDir = join(source, slug)
  if ((await stat(slugDir)).isDirectory() === false) continue
  for (const sessionId of await readdir(slugDir)) {
    const sessionDir = join(slugDir, sessionId)
    if ((await stat(sessionDir)).isDirectory() === false) continue
    for (const file of await readdir(sessionDir)) {
      if (file.endsWith('.zstd') === false) continue
      const target = join(dest, slug, sessionId)
      await mkdir(target, { recursive: true })
      await copyFile(join(sessionDir, file), join(target, file))
      copied++
    }
  }
}

console.log(`已复制 ${copied} 个会话日志到 ${dest}`)
if (copied === 0) console.log(`（没有匹配 "${needle}" 的工作区目录）`)
