/**
 * 只读诊断：用 app-boot 自己的组合函数复现 desktop profile 的组合，
 * 看我们的 bundle 到底有没有被解析、被跳过时原因是什么、组合后有没有那一行。
 *
 * 不写任何文件、不启动运行时。
 * 用法：node --import ./test/register.mjs .verify/diagnose-desktop-compose.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = join(dshHome, 'profiles', 'desktop')

// 应用自带的 dsh 安装锚点。Electron 的运行时在 app.asar（打包文件）里，普通 Node
// 读不到其内部路径，所以这里用同版本的全局安装副本作为锚点来复现 bundle 解析。
const anchors = [
  '<npm-global>\\@deepseek-ai\\dsh\\package.json',
  '<app>\\resources\\app.asar.unpacked\\dsh\\package.json'
].filter((path) => existsSync(path))

const { loadProfileDirectory, composeEntries } = await import('@deepseek-ai/dsh-app-boot')

console.log(`profile = ${profileDir}`)
console.log(`anchors = ${JSON.stringify(anchors)}`)

const profile = loadProfileDirectory('dsh-diagnose', profileDir, anchors[0])

console.log(`\nbundle 层：${profile.layers.length}`)
for (const layer of profile.layers) {
  console.log(`  + ${layer.packageName}  ← ${layer.packageDir}  (patch: ${layer.patchPaths.join(', ')})`)
}

console.log(`\n被跳过的 bundle：${profile.skippedBundles.length}`)
for (const skipped of profile.skippedBundles) {
  console.log(`  ✖ ${skipped.packageName}\n      ${skipped.reason}`)
}

const layers = [...profile.layers.map((layer) => layer.patches), profile.patches]
const entries = composeEntries(layers, (message) => console.log(`  [compose warn] ${message}`))

const ours = entries.filter((entry) => String(entry.name ?? '').includes('workspace-archive') || entry.id === 'workspace-archive')
console.log(`\n组合后条目总数：${entries.length}`)
console.log(`我们那一行：${JSON.stringify(ours, null, 2)}`)

// 顺带看一眼用户 patch 层解析出来的最后一条
console.log(`\n用户 patch 层条目数：${profile.patches.length}`)
console.log(`最后一条：${JSON.stringify(profile.patches.at(-1))}`)
console.log(`\n仓库根（供比对）：${root}`)
