/**
 * 把本插件以 **DSH 应用认得的形态**装进一个真实 profile（默认 desktop）。
 *
 * 应用认的三件事（对照已装好的 `dsh-plugin-branch` 的形态）：
 *   1. profile `package.json` 的 `dependencies` 里有一条 `link:<本仓库>` → 出现在插件页「已安装」；
 *   2. `dsh.profile.bundles` 里有本包名 → 「已启用」（插件页那个开关）；
 *   3. `<profile>/node_modules/<包名>` junction 指向本仓库 → 让包名可解析。
 * 此外在 profile 的**用户 patch 层** `cordis.patch.yml` 里按 id 覆盖配置
 * （与其中 ui-chat / llm-pi-ai 那些条目同一种写法），既不改编译包的默认值，
 * 也不与 bundle 自己声明的行重复插入。
 *
 * 全部改动前都备份，`--uninstall` 逐项还原。
 *
 * 用法：
 *   node .verify/install-desktop.mjs                # 安装
 *   node .verify/install-desktop.mjs --dry-run      # 只打印将要做的改动
 *   node .verify/install-desktop.mjs --uninstall    # 回滚
 *   node .verify/install-desktop.mjs --profile <dir>
 */

import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
/** 依赖 spec 里用的仓库路径：去掉尾部分隔符，和 `dsh-plugin-branch` 的写法保持一致。 */
const rootPath = root.replace(/[\\/]+$/, '')
const PACKAGE_NAME = 'dsh-plugin-workspace-archive'
const ROW_ID = 'workspace-archive'

const START = '# >>> workspace-archive (managed by .verify/install-desktop.mjs)'
const END = '# <<< workspace-archive (managed by .verify/install-desktop.mjs)'

const argv = process.argv.slice(2)
const profileArgIndex = argv.indexOf('--profile')
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME)
  : join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = resolve(profileArgIndex === -1
  ? join(dshHome, 'profiles', 'desktop')
  : argv[profileArgIndex + 1])
const uninstall = argv.includes('--uninstall')
const dryRun = argv.includes('--dry-run')

const manifestFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
const ledgerFile = join(dshHome, 'workspace-archive', 'ledger.json')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')

/** patch 层里由本脚本管理的区域（真机启用：事件驱动 + 兜底轮询）。 */
const MANAGED_BLOCK = `${START}
- id: ${ROW_ID}
  name: ${PACKAGE_NAME}
  config:
    dryRun: false
    confirmDelayMs: 3000
    pollIntervalMs: 300000
    watch: true
${END}
`

/** 去掉本脚本管理的区域（也兼容旧版：无哨兵、直接追加在文件末尾的那一段）。 */
function stripManaged(text) {
  const start = text.indexOf(START)
  if (start !== -1) {
    const end = text.indexOf(END, start)
    const cut = end === -1 ? text.length : end + END.length
    return `${text.slice(0, start)}${text.slice(cut)}`.replace(/\n{3,}/g, '\n\n')
  }
  const legacy = text.indexOf('\n# 工作区会话归档')
  if (legacy !== -1) return `${text.slice(0, legacy)}\n`
  return text
}

/** 找一个「不含本插件名」的 patch 备份：用来回到未被本脚本改过的状态。 */
async function pristinePatchBackup() {
  const entries = await readdir(profileDir).catch(() => [])
  for (const name of entries.filter((n) => n.startsWith('cordis.patch.yml.bak-')).sort().reverse()) {
    const text = await readFile(join(profileDir, name), 'utf8').catch(() => '')
    if (text.includes(PACKAGE_NAME) === false) return join(profileDir, name)
  }
  return undefined
}

async function newestManifestBackup() {
  const entries = await readdir(profileDir).catch(() => [])
  const found = entries.filter((n) => n.startsWith('package.json.bak-') && n.includes('workspace-archive')).sort()
  return found.length === 0 ? undefined : join(profileDir, found.at(-1))
}

async function readManifest() {
  return JSON.parse(await readFile(manifestFile, 'utf8'))
}

async function writeManifest(manifest) {
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

if (uninstall) {
  const manifestBackup = await newestManifestBackup()
  if (manifestBackup !== undefined) {
    await copyFile(manifestBackup, manifestFile)
    console.log(`已还原 package.json：← ${manifestBackup}`)
  } else if (existsSync(manifestFile)) {
    const manifest = await readManifest()
    if (manifest.dependencies?.[PACKAGE_NAME] !== undefined) delete manifest.dependencies[PACKAGE_NAME]
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
    await writeManifest(manifest)
    console.log('已从 package.json 摘掉依赖与 bundle 选择（未找到本脚本的备份）')
  }

  const pristine = await pristinePatchBackup()
  if (existsSync(patchFile)) {
    if (pristine !== undefined) {
      const base = await readFile(pristine, 'utf8')
      await writeFile(patchFile, base.endsWith('\n') ? base : `${base}\n`, 'utf8')
      console.log(`已还原 patch 层：← ${pristine}`)
    } else {
      await writeFile(patchFile, stripManaged(await readFile(patchFile, 'utf8')), 'utf8')
      console.log('已从 patch 层移除本插件的配置覆盖')
    }
  }

  if (existsSync(linkPath)) {
    await rm(linkPath, { recursive: false, force: true })
    console.log(`已删除 junction：${linkPath}`)
  }
  console.log('卸载完成。重启 DSH 后插件不再装载。')
  process.exit(0)
}

if (existsSync(manifestFile) === false) throw new Error(`找不到 profile 清单：${manifestFile}`)
if (existsSync(patchFile) === false) throw new Error(`找不到 profile patch 层：${patchFile}`)

// 1) junction
if (existsSync(linkPath)) {
  console.log(`junction 已存在：${linkPath}`)
} else if (dryRun) {
  console.log(`[dry-run] 将建立 junction：${linkPath} → ${root}`)
} else {
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(root, linkPath, 'junction')
  console.log(`已建立 junction：${linkPath} → ${root}`)
}

// 2) package.json：依赖 + bundles 选择
const manifest = await readManifest()
const expectedSpec = `link:${rootPath}`
const hasDep = manifest.dependencies?.[PACKAGE_NAME] === expectedSpec
const bundles = manifest.dsh?.profile?.bundles ?? []
const hasBundle = bundles.includes(PACKAGE_NAME)

if (hasDep === false || hasBundle === false) {
  if (dryRun) {
    console.log(`[dry-run] 将写 package.json：dependencies += ${PACKAGE_NAME}=${expectedSpec}；bundles += ${PACKAGE_NAME}`)
  } else {
    const backup = `${manifestFile}.bak-${stamp}-workspace-archive`
    await copyFile(manifestFile, backup)
    console.log(`已备份：${backup}`)
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: expectedSpec }
    const nextBundles = [...bundles.filter((name) => name !== PACKAGE_NAME), PACKAGE_NAME]
    manifest.dsh = {
      ...(manifest.dsh ?? {}),
      profile: { ...(manifest.dsh?.profile ?? {}), bundles: nextBundles }
    }
    await writeManifest(manifest)
    console.log(`已写入 package.json：依赖 + bundles 选择（bundles 共 ${nextBundles.length} 项，本包在末尾）`)
  }
} else {
  console.log('package.json 已包含依赖与 bundle 选择，跳过。')
}

// 3) patch 层：同 id 覆盖配置（不动包默认值，也不重复插入行）。已存在时按需**更新**。
const current = await readFile(patchFile, 'utf8')
const desired = `${stripManaged(current).replace(/\s*$/, '\n')}\n${MANAGED_BLOCK}`
if (desired === current) {
  console.log('patch 层的管理区域已是最新，跳过。')
} else if (dryRun) {
  console.log('[dry-run] 将写入 patch 层管理区域（同 id 覆盖 config）')
  console.log(`        当前是否已有管理区域：${current.includes(START)}`)
} else {
  const backup = `${patchFile}.bak-${stamp}-workspace-archive`
  await copyFile(patchFile, backup)
  console.log(`已备份：${backup}`)
  await writeFile(patchFile, desired, 'utf8')
  console.log(current.includes(START) ? '已更新 patch 层的管理区域。' : '已在 patch 层追加管理区域（同 id 覆盖 config）。')
}

console.log(`
安装完成。检查清单：
  1. 重启 DSH（bundle / patch 变更不会被 HMR 热装载）。
  2. 设置 → 插件页的「已安装」应出现 ${PACKAGE_NAME}，开关为**已启用**。
  3. 装载自证：${ledgerFile} 会在第一轮对账后出现，并列出注册表里的工作区。
  4. 回滚：node .verify/install-desktop.mjs --uninstall
`)
