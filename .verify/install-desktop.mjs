/**
 * 把本插件装进一个真实 DSH profile（默认 desktop）。
 *
 * 安装方式（不碰 Electron 应用自己管理的 package.json / bundles）：
 *   1. 在 `<profile>/node_modules/` 建 junction 指向本仓库；
 *   2. 在 profile 的 **用户 patch 层** `cordis.patch.yml` 追加一条 `insert` 行。
 * patch 层是官方文档里"应用在全部 bundle 层之上"的用户层，适合本地 link 的插件；
 * 这样也不会和应用自己写的 `dsh.profile.bundles` 状态互相覆盖。
 *
 * 安装前会备份 `cordis.patch.yml`；卸载（--uninstall）会还原备份并删掉 junction。
 *
 * 用法：
 *   node .verify/install-desktop.mjs                # 安装（默认 desktop profile）
 *   node .verify/install-desktop.mjs --uninstall    # 回滚
 *   node .verify/install-desktop.mjs --profile <dir>
 */

import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const PACKAGE_NAME = 'dsh-plugin-workspace-archive'
/** 插件行的 id：与 package 自己的 cordis.patch.yml 保持一致。 */
const ROW_ID = 'workspace-archive'

const argv = process.argv.slice(2)
const profileArgIndex = argv.indexOf('--profile')
/** DSH 主目录：$DSH_HOME 本身就是主目录，缺省才是 ~/.dsh。 */
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME)
  : join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = resolve(profileArgIndex === -1
  ? join(dshHome, 'profiles', 'desktop')
  : argv[profileArgIndex + 1])
const uninstall = argv.includes('--uninstall')

const patchFile = join(profileDir, 'cordis.patch.yml')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

/** 追加到 patch 层的插件行（真机启用：dryRun 关闭，默认 60s×3 次去抖）。 */
const INSERT_BLOCK = `
# 工作区会话归档：目录消失→归档该目录下由本插件登记的会话；目录回归→按台账恢复。
# 本地 link 安装（.verify/install-desktop.mjs 写入；卸载：--uninstall）。
- insert:
    - id: ${ROW_ID}
      name: ${PACKAGE_NAME}
      config:
        dryRun: false
        pollIntervalMs: 60000
        missingConfirmations: 3
`

async function newestBackup() {
  const entries = await readdir(profileDir).catch(() => [])
  const backups = entries.filter((name) => name.startsWith('cordis.patch.yml.bak-')).sort()
  return backups.length === 0 ? undefined : join(profileDir, backups.at(-1))
}

if (uninstall) {
  const backup = await newestBackup()
  if (backup === undefined) {
    console.log(`没有找到备份，未还原 patch 层：${profileDir}`)
  } else {
    await copyFile(backup, patchFile)
    console.log(`已还原 patch 层：${patchFile}  ←  ${backup}`)
  }
  if (existsSync(linkPath)) {
    await rm(linkPath, { recursive: false, force: true })
    console.log(`已删除 junction：${linkPath}`)
  } else {
    console.log(`junction 不存在：${linkPath}`)
  }
  console.log('卸载完成。重启 DSH 后插件不再装载。')
  process.exit(0)
}

if (existsSync(patchFile) === false) {
  throw new Error(`找不到 profile 的 patch 层：${patchFile}`)
}

// 1) junction（先建，patch 引用它之后立刻可解析）
if (existsSync(linkPath)) {
  console.log(`junction 已存在：${linkPath}`)
} else {
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(root, linkPath, 'junction')
  console.log(`已建立 junction：${linkPath}  →  ${root}`)
}

// 2) patch 层插入（幂等：已存在就不重复写）
const text = await readFile(patchFile, 'utf8')
if (text.includes(PACKAGE_NAME)) {
  console.log(`patch 层已包含 ${PACKAGE_NAME}，未重复写入。`)
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${patchFile}.bak-${stamp}`
  await copyFile(patchFile, backup)
  console.log(`已备份：${backup}`)
  await writeFile(patchFile, `${text.replace(/\s*$/, '\n')}${INSERT_BLOCK}`, 'utf8')
  console.log(`已插入插件行：${patchFile}`)
}

console.log(`
安装完成。接下来：
  - DSH 的 HMR 若接管了这次配置变更，插件会热装载；否则重启 DSH 后生效。
  - 装载成功的可观察证据：${join(dshHome, 'workspace-archive', 'ledger.json')}
    会在第一轮对账后出现，并列出注册表里的工作区。
  - 回滚：node .verify/install-desktop.mjs --uninstall
`)
