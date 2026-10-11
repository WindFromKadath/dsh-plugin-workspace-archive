#!/usr/bin/env node
/**
 * `dsh-session-migrate` —— 离线迁移工具的 CLI。
 *
 * 为什么要独立成 CLI 而不是塞进插件：它要**直写 `sessions/`**，而插件赖以立身的两条是
 * 「运行时只走官方 API」+「零依赖」（见 AGENTS.md D009）。放这里，插件运行时代码一行不改。
 *
 * **本步只有只读子命令 `plan`**：扫描 + 预检 + 打印计划，**不写任何文件**。
 * 写入（备份 / 改写 / 搬目录 / 回滚）与在线层（官方 attach）是后续步骤。
 *
 * 用法：
 *   node bin/dsh-session-migrate.mjs plan --from <cwd> --to <cwd> [选项]
 *
 * 选项：
 *   --from <cwd>        源 cwd（会话当前所属的工作区路径）
 *   --to <cwd>          目标 cwd（必须是一个**已存在**的目录）
 *   --sessions <root>   sessions 根，默认 `$DSH_HOME/sessions` 或 `~/.dsh/sessions`
 *   --session <id>      只处理这条会话（可重复）
 *   --json              输出机器可读的 JSON
 *
 * 退出码：0 = 计划可用；2 = 计划被阻塞（**不是**崩溃）；1 = 用法或内部错误。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildPlan, describePlan } from '../offline/plan.js'

const USAGE = `用法：node bin/dsh-session-migrate.mjs plan --from <cwd> --to <cwd> [选项]

选项：
  --sessions <root>   sessions 根（默认 $DSH_HOME/sessions 或 ~/.dsh/sessions）
  --session <id>      只处理这条会话（可重复）
  --json              输出 JSON
  --help              显示本帮助

退出码：0 计划可用 / 2 计划被阻塞 / 1 用法或内部错误`

function parseArgs(argv) {
  const options = { sessions: null, from: null, to: null, only: [], json: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--from') options.from = argv[++index]
    else if (arg === '--to') options.to = argv[++index]
    else if (arg === '--sessions') options.sessions = argv[++index]
    else if (arg === '--session') options.only.push(argv[++index])
    else throw new Error(`无法识别的参数：${arg}`)
  }
  return options
}

function defaultSessionsRoot() {
  const home = process.env.DSH_HOME
  return home !== undefined && home.length > 0
    ? join(home, 'sessions')
    : join(homedir(), '.dsh', 'sessions')
}

async function main(argv) {
  const [subcommand, ...rest] = argv
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE)
    return 0
  }
  if (subcommand !== 'plan') {
    console.error(`未知子命令：${subcommand}\n\n${USAGE}`)
    return 1
  }

  const options = parseArgs(rest)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.from === null || options.to === null) {
    console.error(`plan 需要 --from 与 --to\n\n${USAGE}`)
    return 1
  }

  const plan = await buildPlan({
    sessionsRoot: resolve(options.sessions ?? defaultSessionsRoot()),
    fromCwd: options.from,
    toCwd: options.to,
    only: options.only.length > 0 ? options.only : undefined
  })

  console.log(options.json ? JSON.stringify(plan, null, 2) : describePlan(plan))
  if (plan.ok) return 0
  if (options.json === false) {
    console.error('\n（本命令是只读预演：没有写任何文件。修掉上面的阻塞再往下走。）')
  }
  return 2
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(`内部错误：${error?.stack ?? String(error)}`)
    process.exitCode = 1
  }
)
