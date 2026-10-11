#!/usr/bin/env node
/**
 * `dsh-session-migrate` —— 离线迁移工具的 CLI。
 *
 * 为什么要独立成 CLI 而不是塞进插件：它要**直写 `sessions/`**，而插件赖以立身的两条是
 * 「运行时只走官方 API」+「零依赖」（见 AGENTS.md D009）。放这里，插件运行时代码一行不改。
 *
 * 子命令：
 *   plan     只读预演：扫描 + 预检 + 打印计划，**不写任何文件**
 *   apply    执行计划：**会真正改动文件**（先备份 → 改写第 0 帧 → 搬到新 projectKey → 自检 → 删源）
 *   rollback 用备份回到改动前
 *
 * 用法：
 *   node bin/dsh-session-migrate.mjs plan     --from <cwd> --to <cwd> [选项]
 *   node bin/dsh-session-migrate.mjs apply    --from <cwd> --to <cwd> --backup <dir> --i-have-stopped-dsh [选项]
 *   node bin/dsh-session-migrate.mjs rollback --backup <dir>
 *
 * 退出码：0 成功 / 2 被拒绝或被阻塞（**不是**崩溃）/ 1 用法或内部错误
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { applyPlan, probeDshRunning, rollback } from '../offline/apply.js'
import { buildPlan, describePlan } from '../offline/plan.js'

const USAGE = `用法：
  node bin/dsh-session-migrate.mjs plan     --from <cwd> --to <cwd> [选项]
  node bin/dsh-session-migrate.mjs apply    --from <cwd> --to <cwd> --backup <dir> --i-have-stopped-dsh [选项]
  node bin/dsh-session-migrate.mjs rollback --backup <dir>

公共选项：
  --from <cwd>        源 cwd（会话当前所属的工作区路径）
  --to <cwd>          目标 cwd（必须是一个**已存在**的目录）
  --sessions <root>   sessions 根（默认 $DSH_HOME/sessions 或 ~/.dsh/sessions）
  --session <id>      只处理这条会话（可重复）
  --json              输出 JSON
  --help              显示本帮助

apply 额外要求：
  --backup <dir>            备份根目录（**必填**，不设默认值，避免悄悄写到意料之外的地方）
  --i-have-stopped-dsh      显式声明 DSH 已完全退出（**必填**）
  --intent <path>           迁移意图文件路径（默认 $DSH_HOME/workspace-archive/pending-migrations.json）

apply 成功后会在意图文件里记下"这些会话现在属于新路径了"。**重启 DSH 后**，插件读到它就会用官方
attachSession 把它们挂到新工作区的分组里（依然只走官方 API，不直写 storages/）。

退出码：0 成功 / 2 被拒绝或被阻塞 / 1 用法或内部错误`

function parseArgs(argv) {
  const options = {
    sessions: null, from: null, to: null, backup: null, intent: null,
    only: [], json: false, help: false, stopped: false
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--i-have-stopped-dsh') options.stopped = true
    else if (arg === '--from') options.from = argv[++index]
    else if (arg === '--to') options.to = argv[++index]
    else if (arg === '--sessions') options.sessions = argv[++index]
    else if (arg === '--backup') options.backup = argv[++index]
    else if (arg === '--intent') options.intent = argv[++index]
    else if (arg === '--session') options.only.push(argv[++index])
    else throw new Error(`无法识别的参数：${arg}`)
  }
  return options
}

function defaultSessionsRoot() {
  const home = process.env.DSH_HOME
  return home !== undefined && home.length > 0 ? join(home, 'sessions') : join(homedir(), '.dsh', 'sessions')
}

/** 意图文件的默认位置：与插件的 sidecar 同目录。 */
function defaultIntentPath() {
  const home = process.env.DSH_HOME
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(root, 'workspace-archive', 'pending-migrations.json')
}

function planOf(options) {
  return buildPlan({
    sessionsRoot: resolve(options.sessions ?? defaultSessionsRoot()),
    fromCwd: options.from,
    toCwd: options.to,
    only: options.only.length > 0 ? options.only : undefined
  })
}

function report(options, payload, text) {
  console.log(options.json ? JSON.stringify(payload, null, 2) : text)
}

async function main(argv) {
  const [subcommand, ...rest] = argv
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE)
    return 0
  }
  if (['plan', 'apply', 'rollback'].includes(subcommand) === false) {
    console.error(`未知子命令：${subcommand}\n\n${USAGE}`)
    return 1
  }

  const options = parseArgs(rest)
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  // ── rollback：只需要备份目录 ─────────────────────────────
  if (subcommand === 'rollback') {
    if (options.backup === null) {
      console.error(`rollback 需要 --backup <dir>\n\n${USAGE}`)
      return 1
    }
    const result = await rollback(resolve(options.backup))
    report(
      options,
      result,
      result.ok === true
        ? `已回滚 ${result.restored} 条会话：源目录放回、目标目录删除。\n备份仍保留在 ${resolve(options.backup)}（确认无误后可自行删除）。`
        : `回滚未完成：${result.reason}（已回滚 ${result.restored?.length ?? 0} 条）`
    )
    return result.ok === true ? 0 : 2
  }

  if (options.from === null || options.to === null) {
    console.error(`${subcommand} 需要 --from 与 --to\n\n${USAGE}`)
    return 1
  }

  // ── plan：只读 ───────────────────────────────────────────
  if (subcommand === 'plan') {
    const plan = await planOf(options)
    report(options, plan, describePlan(plan))
    if (plan.ok !== true && options.json === false) {
      console.error('\n（本命令是只读预演：没有写任何文件。修掉上面的阻塞再往下走。）')
    }
    return plan.ok === true ? 0 : 2
  }

  // ── apply：写入闸门先全部过完，再动任何文件 ──────────────
  if (options.stopped !== true) {
    console.error('拒绝执行：必须先确认 DSH 已**完全退出**，然后显式加 --i-have-stopped-dsh。')
    console.error('（本工具不会替你判断进程是否还在跑：Windows 上没有可靠的检测方式，与其静默失效，不如要求你显式声明。）')
    return 2
  }
  if (options.backup === null) {
    console.error(`apply 需要 --backup <dir>（备份根目录，必填）\n\n${USAGE}`)
    return 1
  }

  const liveness = await probeDshRunning()
  if (liveness === 'running') {
    console.error('拒绝执行：进程表里似乎还有 DSH 在跑。请先完全退出它。（这是尽力而为的检测，认不出时返回 unknown。）')
    return 2
  }

  const plan = await planOf(options)
  if (plan.ok !== true) {
    report(options, plan, describePlan(plan))
    if (options.json === false) console.error('\n拒绝执行：计划不可用（上面有阻塞）。先跑 `plan` 修掉它们。')
    return 2
  }

  const result = await applyPlan(plan, {
    backupRoot: resolve(options.backup),
    confirmed: true,
    intentPath: resolve(options.intent ?? defaultIntentPath())
  })
  report(
    options,
    { plan: { fromCwd: plan.fromCwd, toCwd: plan.toCwd, total: plan.summary.total }, liveness, result },
    result.ok === true
      ? [
        `已迁移 ${result.migrated} 条会话：${plan.fromCwd} → ${plan.toCwd}`,
        `备份：${result.backupDir}`,
        result.intentPath === null
          ? '（没写迁移意图：一条都没搬成）'
          : `迁移意图：${result.intentPath}\n  重启 DSH 后，插件会把它们挂到新工作区的分组里（只走官方 attachSession）。`,
        '回滚：node bin/dsh-session-migrate.mjs rollback --backup ' + result.backupDir
      ].join('\n')
      : `迁移未完成：${result.reason}${result.detail === undefined ? '' : `（${result.detail}）`}`
        + `\n已迁移 ${result.migrated?.length ?? 0} 条；备份在 ${result.backupDir ?? '(无)'}`
        + `\n可以用 rollback 回到改动前。`
  )
  return result.ok === true ? 0 : 2
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(`内部错误：${error?.stack ?? String(error)}`)
    process.exitCode = 1
  }
)
