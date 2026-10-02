# plugin-2 · 工作区会话归档与恢复（DSH 插件）· 开发项目

> 为「本机 DSH Desktop 使用者」解决「工作区文件夹被删/被移动后，其中的历史对话无人接管；文件夹放回来时旧对话不会自动回来」的问题。先完成一个可验证的使用场景，再逐步扩展。

## 目标与范围

- 本轮用户场景：我在 DSH 里对某个工作区目录跑过若干会话，之后把这个文件夹**删除或移走**；我希望这些对话不要散落成“未分组”；等我把**同一个目录放回来**时，希望原来的对话能自动回到该工作区并可以继续聊。
- 完成定义：
  1. **目录消失**后，插件把该目录下**由本插件登记的**会话归档，侧栏默认视图不再显示它们（可在“全部对话（显示已归档）”中看到，且可手动取消归档）；
  2. **项目登记被移除**（菜单里的「删除工作区」——只删登记、文件夹还在）同样视为消失并归档，避免对话散落成“无项目”（2026-10-02 用户确认的语义）；
  3. 上述任一消失原因对应的目录/项目**回来**后，**仅**把本插件归档过的那批会话恢复，用户手动归档的会话保持归档；
  4. 全过程只调用官方 API（`workspaceRegistry.archiveSession/unarchiveSession`），不直接改官方存储文件；失败可重放、可撤销；
  5. 上述场景各有真机验证记录（含正常案例 + 边界/失败案例）。
- 本轮范围与限制：
  - **只做需求②**。需求①（总结对话自动命名）经勘察已被生态覆盖（`@weibaohui/dsh-smart-title` 等），默认**不复刻**，只保留评估结论（见 [docs/recon/README.md](docs/recon/README.md) §2）。
  - 不改动、不覆盖 `app.asar` 内的任何官方包；数据只写本插件自己的 sidecar 与官方 registry API。
  - 不做会话删除、不删文件夹、不做跨机器同步。
  - 已知硬约束（设计前提，出处见 [docs/recon/02-workspace-session-archive.md](docs/recon/02-workspace-session-archive.md)）：目录消失**不产生任何事件**（只能轮询）；注册表的失效 id 会被下一次 workspace 写操作**永久 prune**（必须抢在前面记台账）；重新添加目录会**新建空项目**（不能靠 workspaceId 认亲）；`archivedSessionIds` **无来源标记**（必须靠 sidecar 区分）。

## 作者视角（我用自己的话维护）

- 核心路径：{{用户操作 → 关键处理或数据流 → 可见结果}}
- 当前为什么这样做：{{最重要的取舍及其依据，引用下方决策编号}}
- 下一步要弄清：{{具体疑点、准备怎样检查、我预期看到什么}}

> 这三行由作者本人填写。Agent 可以对照代码/运行结果指出错误，但不得代替作者写理解。

## 运行与验证

| 用途 | 实际命令或操作 |
|---|---|
| 准备环境 | 已建立：`package.json`（含 `dsh.bundle.patch`）+ `cordis.patch.yml` + `src/index.js`。**不需要 `pnpm install`**：`@deepseek-ai/*` 由宿主提供，本地测试用 `test/register.mjs` 解析钩子指向已安装的 profile。 |
| 启动项目 | **已装入 desktop profile**（2026-10-02，应用认得的形态）：`node .verify/install-desktop.mjs` 写入 ①`package.json` 的 `dependencies["dsh-plugin-workspace-archive"] = "link:…\\plugin-2"`（→ 插件页「已安装」列表读这里）②`dsh.profile.bundles` 追加本包名（→ 页面上那个启用开关）③`node_modules` junction ④patch 层按 id 覆盖配置（`dryRun: false`、60s×3）。备份：`package.json.bak-*-workspace-archive`、`cordis.patch.yml.bak-*-workspace-archive`。**待重启 DSH 生效**（实测 HMR 从不热装载，三次共等 400+ 秒）。回滚：`node .verify/install-desktop.mjs --uninstall`。 |
| 检查本轮改动 | `npm run check`（语法）；`npm test`（= `node --import ./test/register.mjs --test --test-isolation=none "tests/*.test.mjs"`，当前 **33 项通过**，含真 Cordis 上下文装载、端到端假注册表场景、以及"插件源码不得 import 宿主包"的回归断言）。沙箱内必须用 `--test-isolation=none`：默认 runner 会以管道 stdio 起子进程，在 DSH 文件沙箱下报 `EPERM`；普通终端可用 `npm run test:isolated`。 |
| 诊断装载问题 | `node --import ./test/register.mjs .verify/diagnose-desktop-compose.mjs`：用 app-boot 自己的组合函数**只读**复现 desktop profile 的组合，打印每个 bundle 层、被跳过的 bundle 及原因、组合后有没有我们那一行。实测：7 层全部加载、0 跳过、195 条里含 `workspace-archive` ⇒ 组合层没问题，故障只可能在模块加载。 |
| 重现关键场景 | **已可一键重跑**：`npm run rm-test`（= `node --import ./test/register.mjs .verify/real-machine.mjs`）。它在工作区内的临时 `DSH_HOME`（`.verify/home`）里启动**真的 DSH 运行时**（真 Loader / 真会话持久化 / 真 storage-domain / 真工作区注册表），跑完整场景：建工作区 → 建两个真会话（A 交插件管，B 模拟用户手动归档）→ 删目录 → 断言 A 归档且 B 未被接管 → 放回目录 → 断言 A 恢复且 **B 仍然归档**。**当前 14/14 通过**，且会核对用户真实 `~/.dsh` 归档数未变（96→96）。**不碰 desktop profile、不碰真实工作区目录。** |

占位内容须先填好；尚无运行环境时，把验证状态记为待验证。

## 项目入口

- [AGENTS.md](AGENTS.md)：Agent 接手、执行和写文件的规则（含本机 DSH 环境事实与危险操作边界）。
- [tasks.csv](tasks.csv)：当前功能与缺陷任务；状态为 `todo / doing / blocked / done`。
- `src/`：实现；`tests/`：必要检查；`artifacts/`：运行日志、截图或其他验收证据。
- [docs/recon/README.md](docs/recon/README.md)：本轮之前完成的官方能力与生态勘察总报告（设计依据，非交付物）。

任务表的 `acceptance` 在实施前确定，`scope` 指向相关代码或模块。`evidence` 保存验证方式和产物位置，`verified_revision`、`verified_at` 对应验证时的代码版本与日期；实现变化后重新判断原有证据是否适用。

## 一轮工作

1. 选一个用户场景，把正常表现和关键失败表现写进任务表。
2. 检查相关代码与现有行为，完成一组容易审查的改动。
3. 按场景实际运行，检查与改动有关的测试；无需为简单排版建立完整测试套件。
4. 通过后更新同一任务行和证据位置，在对话中汇报；用户反馈不符时继续修正。

## 已采纳的关键取舍

仅记录会影响后续实现的决定。建议尚未采纳时留在任务讨论中；改变既有决定时保留原编号和替代理由。

| 编号 | 日期 | 决定与原因 | 依据或确认人 | 状态或替代关系 |
|---|---|---|---|---|
| D001 | 2026-10-02 | 项目骨架采用 `NewToLearn\AI协作SOP\项目模板\01-开发项目`（入口 README + AGENTS.md + tasks.csv + src/tests/artifacts），不另建并行文档体系 | 用户 2026-10-02 指令 | 已采纳 |
| D002 | 2026-10-02 | 勘察阶段的所有结论放 `docs/recon/`，作为实现的设计依据；不复制进 README | [docs/recon/README.md](docs/recon/README.md)（Lead 复核） | 已采纳 |
| D003 | 2026-10-02 | 归档必须先写 sidecar 台账再调 `archiveSession`，恢复只处理 sidecar 交集 | [02](docs/recon/02-workspace-session-archive.md) §硬约束 ③（`archivedSessionIds` 无来源标记） | 建议，待 F003 验证后转已采纳 |
| D004 | 2026-10-02 | 本轮只做需求②；需求①不复刻，只保留评估结论（F006） | 用户 2026-10-02 选择确认 | 已采纳 |
| D005 | 2026-10-02 | 测试默认脚本加 `--test-isolation=none`：DSH 沙箱下默认 runner 的管道子进程会 `EPERM`；另留 `test:isolated` 供普通终端 | 本机实测（`npm test` 通过） | 已采纳 |
| D006 | 2026-10-02 | 不 import `@deepseek-ai/dsh-workspace`（避免额外 peer）：活动拒绝按 `name/activity` 识别；定时器走可选 `ctx.get('timer')` 并把退化路径也纳入测试 | 真 Cordis 装载实测（直接读 `ctx.interval` 会抛 "cannot get property interval without inject"） | 已采纳 |
| D007 | 2026-10-02 | 归档前必须复核官方 `registry.archivedSessionIds`，已在其中的会话**不得**记入本插件台账 | **真机测试抓到**：官方 `archiveSession` 对已归档 id 幂等，首轮真机把用户手动归档的成员也记成自己的账，恢复时把用户归档一并解除 | 已采纳（`81234e3`） |
| D008 | 2026-10-02 | 装进 desktop profile 用「package.json 依赖 + bundles 开关 + junction + patch 层按 id 覆盖配置」；**不**改 app 自己管理的字段以外的东西 | 本地 link 走不了 `dsh plugin --profile desktop`（launcher 明确拒绝）；插件页「已安装」读的就是 `dependencies`，只建 junction 不会出现（第一版白装的教训） | 已采纳（`--uninstall` 可回滚） |
| D009 | 2026-10-02 | 插件**零外部依赖**：不 import `@deepseek-ai/schemastery`（不再导出 `Config`）、不 import `dsh-home-paths`（自己按 `ctx.get('dshHomePath')` → `$DSH_HOME` → `~/.dsh` 解析） | **真机装载失败抓到**：junction 装载时 Node 按真实路径解析嵌套 import，够不到宿主包 → `ERR_MODULE_NOT_FOUND`。代价：没有 schemastery 的配置 schema（UI/config dump 不再列字段），校验与默认值由 `resolveConfig` 全权负责，已有测试覆盖 | 已采纳（`68bbe7f`） |
| D010 | 2026-10-02 | 消失信号有两个：**目录不存在** + **项目登记被移除**（菜单「删除工作区」只删登记、不动文件夹）。台账里独有的路径即视为"登记消失" | 用户 2026-10-02 确认（"删除工作区后对话还是变成无项目"就是缺这一条）。加**启动瞬态保护**：本进程未见过非空注册表时不据"登记消失"归档，避免 bootstrap 未完成时误判 | 已采纳（真机 19/19） |

**现场演示（2026-10-02，真机、真注册表、真会话）**：用一次性工作区 `plugin-2\.verify\demo-ws`（已 gitignore）——
① 健康轮台账记下 `demo-ws` + 会话 `session-f624ddb3…`；② 目录改名 → `missingSince=06:07:27Z`、台账与**官方** `workspace.json` 的归档集合都含该会话；③ 目录改回 → 台账清空、官方归档集合移除它。全程 5 个工作区的插件归档数保持 0，用户手动归档集合未被误动（96→98 的 +2 经审计为**插件之外**的孤儿会话归档，见对话记录）。

## 给 Agent 的启动语

> 请读 AGENTS.md、README.md 和 tasks.csv 中本次任务行，再检查相关实现。按已确定的用户场景完成一个小块并验证，更新已有任务记录，在对话中给出证据与未解决问题。若关键路径改变，说明依据和影响，提供一个便于作者检查的实际场景；作者视角由我理解后回写。
