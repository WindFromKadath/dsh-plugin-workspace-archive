/**
 * 只读组合预检：用 app-boot 自己的组合函数复现 `desktop` profile 的组合，
 * 看本插件这个 bundle 有没有被解析、被跳过时原因是什么、组合后有没有我们那一行。
 *
 * 这是**重启前**能拿到的最强证据：它读的就是应用启动时会读的那套清单
 * （profile 的 `package.json` + `node_modules` + 各 bundle 的 `dsh.bundle.patch`），
 * 但不启动运行时、不开端口、不写任何文件。
 *
 * 用法：
 *   $env:NPM_GLOBAL_ROOT = (npm root -g)
 *   node --import ./test/register.mjs .verify/diagnose-desktop-compose.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-plugin-workspace-archive'
const ROW_ID = 'workspace-archive'
const root = fileURLToPath(new URL('../', import.meta.url))
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', 'desktop')

// 组合锚点：应用自带的 dsh 在 app.asar 里，普通 Node 读不到其内部路径；
// 用**同版本**的全局安装副本作锚点即可复现 bundle 解析（本机两者都是 0.2.0-rc.2）。
// 路径不写死在本文件里（盘符绝对路径既是隐私检查的阻断项、换机器也会过期），按环境变量给：
//   DSH_ANCHOR_GLOBAL / DSH_ANCHOR_APP —— 直接指定 dsh 的 package.json
//   NPM_GLOBAL_ROOT                    —— `npm root -g` 的输出（即全局 node_modules 目录本身）
//   ProgramFiles                       —— 系统变量，用于推导桌面应用的解包目录
const anchors = [
  process.env.DSH_ANCHOR_GLOBAL,
  process.env.DSH_ANCHOR_APP,
  process.env.NPM_GLOBAL_ROOT === undefined ? undefined : join(process.env.NPM_GLOBAL_ROOT, '@deepseek-ai', 'dsh', 'package.json'),
  process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'package.json')
].filter((path) => typeof path === 'string' && path !== '' && existsSync(path))

if (anchors.length === 0) {
  console.error('找不到任何 dsh 安装锚点；请设置 DSH_ANCHOR_GLOBAL（或 NPM_GLOBAL_ROOT）指向全局安装的 dsh')
  process.exitCode = 1
  process.exit()
}

const { loadProfileDirectory, composeEntries } = await import('@deepseek-ai/dsh-app-boot')

console.log(`profile = ${profileDir}`)
console.log(`anchors = ${JSON.stringify(anchors)}`)

const profile = loadProfileDirectory('dsh-diagnose', profileDir, anchors[0])

console.log(`\nbundle 层：${profile.layers.length}`)
for (const layer of profile.layers) {
  console.log(`  + ${layer.packageName}  (patch: ${layer.patchPaths.join(', ')})`)
}

console.log(`\n被跳过的 bundle：${profile.skippedBundles.length}`)
for (const skipped of profile.skippedBundles) {
  console.log(`  ✖ ${skipped.packageName}\n      ${skipped.reason}`)
}

const layers = [...profile.layers.map((layer) => layer.patches), profile.patches]
const entries = composeEntries(layers, (message) => console.log(`  [compose warn] ${message}`))

const ours = entries.filter((entry) => entry.id === ROW_ID || String(entry.name ?? '').includes(PACKAGE))
console.log(`\n组合后条目总数：${entries.length}`)
console.log(`我们那一行：${JSON.stringify(ours, null, 2)}`)

// 顺带看一眼用户 patch 层解析出来的最后一条
console.log(`\n用户 patch 层条目数：${profile.patches.length}`)
console.log(`最后一条：${JSON.stringify(profile.patches.at(-1))}`)
console.log(`\n仓库根（供比对）：${root}`)

const loaded = profile.layers.some((layer) => layer.packageName === PACKAGE)
const skipped = profile.skippedBundles.some((item) => item.packageName === PACKAGE)
console.log(`\n结论：bundle 已解析 = ${loaded}；被跳过 = ${skipped}；组合含我们那一行 = ${ours.length > 0}`)
process.exitCode = loaded && skipped === false && ours.length > 0 ? 0 : 1
