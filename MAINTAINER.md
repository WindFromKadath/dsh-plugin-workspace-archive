# MAINTAINER.md — 作者侧维护入口

面向**维护者**（人 + 后续 agent）。公开读者请先看 [README.md](README.md)（中文主入口）/ [README.en.md](README.en.md)（English）；这里保存作者理解、内部流程、已采纳取舍与证据线索。

## 1. 本轮范围与作者视角

- 本轮用户场景：在 DSH 里对某个工作区目录跑过若干会话，之后把这个文件夹**删除或移走**；希望这些对话不要散落成"未分组"；等**同一个目录放回来**时，希望原来的对话能自动回到该工作区并可以继续聊。
- 完成定义：
  1. **目录消失**后，插件把该目录下**由本插件登记的**会话归档，侧栏默认视图不再显示（可在"全部对话（显示已归档）"看到，也可手动取消归档）；
  2. **项目登记被移除**（菜单「删除工作区」——只删登记、文件夹还在）同样视为消失并归档（2026-10-02 用户确认的语义）；
  3. 目录/项目**回来**后：本插件归档过的那批**取消归档**；台账快照里的**全部成员**（含消失前就已归档的）**挂回**同一路径工作区的分组，且**不改后者的归档状态**（D012/D013）；
  4. 全过程只调官方 API（`workspaceRegistry.archiveSession/unarchiveSession` + `Workspace.attachSession`），不直接改官方存储文件；失败可重放、可撤销；
  5. 上述场景各有真机验证记录（正常案例 + 边界/失败案例）。
- 范围与限制：**只做需求②**（需求①"总结对话自动命名"经勘察已被生态覆盖，默认不复刻，结论见 [docs/recon/README.md](docs/recon/README.md) §2）；不改 `app.asar`；不做会话删除、不删文件夹、不做跨机器同步。
- 已知硬约束（设计前提，出处见 [docs/recon/02-workspace-session-archive.md](docs/recon/02-workspace-session-archive.md)）：目录消失**不产生任何事件**（只能轮询）；注册表的失效 id 会被下一次 workspace 写操作**永久 prune**（必须抢在前面记台账）；重新添加目录会**新建空项目**（不能靠 workspaceId 认亲，恢复必须显式 `attachSession` 挂回；反过来，**记录 id 变了**正是"经历过一次消失"的可靠判据）；`archivedSessionIds` **无来源标记**（必须靠 sidecar 区分）。

### 作者视角（由作者本人填写）

- 核心路径：{{用户操作 → 关键处理或数据流 → 可见结果}}
- 当前为什么这样做：{{最重要的取舍及其依据，引用下方决策编号}}
- 下一步要弄清：{{具体疑点、准备怎样检查、我预期看到什么}}

> 这三行由作者本人填写。Agent 可以对照代码/运行结果指出错误，但不得代替作者写理解。

## 2. 项目入口与工作方式

- [AGENTS.md](AGENTS.md)：Agent 接手、执行与写文件的规则（含环境事实与危险操作边界）。
- [tasks.csv](tasks.csv)：当前功能与缺陷任务；状态 `todo / doing / blocked / done`。
- `src/` 实现；`tests/` 离线检查；`.verify/` 真机装置与装机脚本；`artifacts/` 验收证据。
- [docs/recon/README.md](docs/recon/README.md)：本轮之前的官方能力与生态勘察总报告（设计依据）。
- [.privacy-tools/README.md](.privacy-tools/README.md)：提交前隐私检查怎么跑、当前结果与已知误报。
- [.privacy-tools/VERIFICATION.md](.privacy-tools/VERIFICATION.md)：历史改写与上传后的核验记录。

一轮工作：① 选一个用户场景，把正常表现与关键失败表现写进任务表；② 检查相关代码与现有行为，完成一组容易审查的改动；③ 按场景实际运行，检查与改动有关的测试；④ 通过后更新同一任务行与证据位置，在对话中汇报；用户反馈不符时继续修正。

任务表的 `acceptance` 在实施前确定，`scope` 指向相关代码或模块；`evidence` 保存验证方式与产物位置，`verified_revision` / `verified_at` 对应验证时的代码版本与日期。

## 3. 运行与验证

| 用途 | 实际命令或操作 |
|---|---|
| 准备环境 | `package.json`（含 `dsh.bundle.patch`）+ `cordis.patch.yml` + `src/index.js`。**不需要 `pnpm install`**：`@deepseek-ai/*` 由宿主提供，本地测试用 `test/register.mjs` 的解析钩子指向已安装的 profile。 |
| 检查改动 | `npm run check`（语法）；`npm test`（= `node --import ./test/register.mjs --test --test-isolation=none "tests/*.test.mjs"`，**48 项**：真 Cordis 上下文装载、端到端假注册表场景、事件入口/watcher/跟进对账、恢复挂回工作区的 attach 断言（含"用户手动归档的成员也挂回但保持归档"与"平时不重挂"两条反例）、"插件源码不得 import 宿主包"的回归）。沙箱内必须 `--test-isolation=none`：默认 runner 以管道 stdio 起子进程，在 DSH 文件沙箱下报 `EPERM`；普通终端可用 `npm run test:isolated`。 |
| 重现关键场景 | `npm run rm-test`（= `node --import ./test/register.mjs .verify/real-machine.mjs`）：在仓库内一次性 `DSH_HOME`（`.verify/home`）里启动**真** DSH 运行时（真 Loader / 真会话持久化 / 真 storage-domain / 真工作区注册表），五个阶段跑「建工作区 → 建两个真会话（A 交插件管，B 模拟用户手动归档）→ 删目录 → 断言 A 归档且 B 未被接管 → 放回目录 → 断言 A 恢复且 B 仍然归档 → `registry.delete()` 模拟「删除工作区」→ 断言 A 归档 → `registry.create()` 重新添加 → 断言 A 与 B **都被挂回新项目**且 B 仍在归档集合」。**当前 27/27**，并核对用户真实 `~/.dsh` 归档数未变。 |
| 装机（本机 desktop） | `node .verify/install-desktop.mjs`（幂等）写入四项：① profile `package.json` 的 `dependencies[name] = link:<repo>`（插件页「已安装」读这里）② `dsh.profile.bundles` 追加本包名 ③ `<profile>/node_modules/<name>` junction ④ patch 层按 id 覆盖 `dryRun:false / confirmDelayMs:3000 / pollIntervalMs:300000 / watch:true`。只读核对：`--status`（五项）。回滚：`--uninstall`（**逐项精准移除**，不做整体还原）。**必须完全退出并重开应用**（HMR 从不热装载；改 `src/` 后同样要重启）。 |
| 组合预检 | `$env:NPM_GLOBAL_ROOT = (npm root -g)`；`node --import ./test/register.mjs .verify/diagnose-desktop-compose.mjs`：用 app-boot 自己的组合函数**只读**复现 profile 组合，结论不一致时退出码非 0。锚点不写死（按 `NPM_GLOBAL_ROOT` / `DSH_ANCHOR_GLOBAL` / `DSH_ANCHOR_APP` 给）。2026-10-07 实测 10 层全加载 / 0 跳过 / 198 条含本行。 |
| 隐私检查 | `pwsh -NoProfile -File .privacy-tools\Invoke-PrivacyCheck.ps1 -Repo . -Mode Staged -Policy .privacy-tools\privacy-policy.json`（日常）；`Index` / `History` 见 [.privacy-tools/README.md](.privacy-tools/README.md)。Hook 模板已复制但**未启用**。 |

## 4. 已采纳的关键取舍

仅记录会影响后续实现的决定。改变既有决定时保留原编号与替代理由。

| 编号 | 日期 | 决定与原因 | 依据或确认人 | 状态 |
|---|---|---|---|---|
| D001 | 2026-10-02 | 项目骨架采用「开发项目」模板（入口 README + AGENTS.md + tasks.csv + src/tests/artifacts），不另建并行文档体系 | 用户指令 | 已采纳 |
| D002 | 2026-10-02 | 勘察结论放 `docs/recon/`，作为设计依据，不复制进 README | [docs/recon/README.md](docs/recon/README.md)（Lead 复核） | 已采纳 |
| D003 | 2026-10-02 | 归档必须先写 sidecar 台账再调 `archiveSession`；恢复只处理 sidecar 交集 | 02 §硬约束 ③（`archivedSessionIds` 无来源标记） | 已采纳（F003 验证后转正） |
| D004 | 2026-10-02 | 本轮只做需求②；需求①不复刻，只保留评估结论（F006） | 用户选择确认 | 已采纳 |
| D005 | 2026-10-02 | 测试默认脚本加 `--test-isolation=none`（沙箱下默认 runner 的管道子进程 `EPERM`）；另留 `test:isolated` | 本机实测 | 已采纳 |
| D006 | 2026-10-02 | 不 import `@deepseek-ai/dsh-workspace`：活动拒绝按 `name/activity` 识别；定时器走可选 `ctx.get('timer')`，退化路径也纳入测试 | 真 Cordis 装载实测（直接读 `ctx.interval` 会抛 "cannot get property interval without inject"） | 已采纳 |
| D007 | 2026-10-02 | 归档前必须复核官方 `archivedSessionIds`，已在其中的会话**不得**记入本插件台账 | **真机测试抓到**：官方归档对已归档 id 幂等，首轮真机把用户手动归档的成员记成自己的账，恢复时一并解除 | 已采纳（`81234e3`） |
| D008 | 2026-10-02 | 装进 desktop profile 用「依赖 + bundles 开关 + junction + patch 层按 id 覆盖」；不改 app 自己管理的字段以外的东西 | 本地 link 走不了 `dsh plugin --profile desktop`；插件页「已安装」读的就是 `dependencies` | 已采纳（`--uninstall` 可回滚） |
| D009 | 2026-10-02 | 插件**零外部依赖**：不 import `schemastery`、不 import `dsh-home-paths`（自己按 `ctx.get('dshHomePath')` → `$DSH_HOME` → `~/.dsh` 解析） | **真机装载失败抓到**：junction 装载时 Node 按真实路径解析嵌套 import，够不到宿主包 → `ERR_MODULE_NOT_FOUND`。代价：没有 schemastery 的配置 schema，校验与默认值由 `resolveConfig` 全权负责 | 已采纳（`68bbe7f`） |
| D010 | 2026-10-02 | 消失信号有两个：**目录不存在** + **项目登记被移除**；加**启动瞬态保护**（本进程未见过非空注册表时不据"登记消失"归档） | 用户 2026-10-02 确认 | 已采纳（真机 19/19） |
| D011 | 2026-10-02 | 反应模型改为**事件驱动 + 时间确认 + 兜底轮询**：`domain/changed` + 自挂 `fs.watch`（父目录非递归），确认改时间型 `confirmDelayMs`（默认 3 秒）+ 窗口到点跟进对账，兜底轮询 5 分钟 | 宿主对目录消失没有事件（`missing-dir` 零消费方、无 watcher、不写注册表），目录侧只能自己挂 watcher；登记侧本来就有官方事件 | 已采纳（真机 19/19） |
| D012 | 2026-10-07 | **恢复 = 取消归档 + 挂回工作区**：恢复出的会话用官方 `Workspace.attachSession` 挂回**同一路径**的工作区；`attachSession` 是前插，故**倒序**挂回以保持原相对顺序；路径对不上只记日志 | 用户真机反馈「Rust 工作区里对话恢复了但没加回工作区」：官方归档不拆槽位，但「删除工作区 → 重新添加同一目录」会新建**空成员**项目。先在真机装置复现（FAIL `sessionIds:[]`）再修 | 已采纳（真机 21/21、单元 39/39） |
| D013 | 2026-10-07 | **挂回分组与取消归档分成两件事**：`attach` 名单 = 台账快照里**缺席的全部成员**（含消失前就已归档的），只调 `attachSession`、**绝不碰归档集合**；触发条件收紧为"该工作区**经历过一次消失**"（台账 `missingSince` 非空 **或** 官方记录 id 与台账记下的不同），平时绝不下发 | 用户第二轮真机反馈「原本已经归档的对话不会同时归回对应的工作区」：记录被删掉重建后槽位全丢，只恢复"本插件归档过的那批"会漏掉用户归档的那批。判别性断言先红（单测 40/41、真机 FAIL「B 未挂回」）再修 | 已采纳（真机 22/22、单元 41/41） |
| D014 | 2026-10-08 | **「无项目 → 按 cwd 归位」是独立的一次性动作**（T0）：官方 registry 只在第一次启动时按 `header.cwd` 归组（bootstrap 一次性），此后落单会话没有自愈通道。插件启动后延迟跑一次，判据收紧为「不在任何工作区成员表 + `realpath(cwd)` 精确等于某工作区路径 + cwd 可解析」，只调官方 `attachSession`，可用 `adoptUngrouped: false` 关闭；**归档/恢复路径仍然不许按 cwd 反查** | 用户 2026-10-08 要求"把未分组/不同组的对话迁移"；bootstrap 一次性为源码级事实 | 已采纳（单元 48/48、真机 27/27；先红后绿） |
| D015 | 2026-10-08 | **T1 真迁移放行，但落点应是独立工具**：跨 cwd 迁移唯一路径是离线改写会话 header 的 `cwd`（用户放行）；生态 `dsh-mv-session` 因硬编码代际 0 文件名（本机全是 `session.v4.jsonl.zstd`）而**不可直接用**，且它的语义是"整工作区改名"，故只借鉴其帧层纯函数；本插件运行时代码**不破**"只走官方 API" | 用户 2026-10-08 选择"放行红线 + T0 开工 + 并行 T1-0"；T1-0 为源码级评估（见 [docs/plan-session-migration.md](docs/plan-session-migration.md) §2.2） | 已采纳（T1 未开工） |
| D016 | 2026-10-08 | **公开文档语言改为中文为主**：`README.md` = 中文主入口、英文转 `README.en.md`、GitHub About 用中文 | 用户 2026-10-08 直接要求（"DSH 插件主要给国人使用"）；与知识库「GitHub 倾向英文」的约定相反，故在本文件 §6 记明理由与适用范围 | 已采纳 |
| D017 | 2026-10-08 | **npm 发布走分阶段发布 + 网页批准**：账号 2FA 只有安全密钥（通行密钥）⇒ CLI 无 OTP 可用，故用分阶段发布上传、在网页用通行密钥批准 | 实测：`npm publish` 报 E403（要求 2FA 或 bypass 令牌）、`--otp=` 报 EOTP；网页 `Staged Packages` 可批准 | 已采纳（`0.1.0` 已生效） |

## 5. 现场演示与复现记录

- **2026-10-02 现场演示**（真机、真注册表、真会话）：用一次性工作区 `.verify/demo-ws`（已 gitignore）—— ① 健康轮台账记下 `demo-ws` + 会话；② 目录改名 → `missingSince` 落盘、台账与**官方** `workspace.json` 的归档集合都含该会话；③ 目录改回 → 台账清空、官方归档集合移除它。全程用户手动归档集合未被误动。
- **2026-10-07 D012 复现 → 修复**：真机装置第 5 阶段新增成员资格断言后**先红**（`FAIL 重新添加目录：会话 A 被挂回新项目 {"sessionIds":[]}`，20/21）；修完 **21/21**。
- **2026-10-07 D013 复现 → 修复**：同一条断言扩到"已经归档的成员"后**再红**（单测 40/41、真机 FAIL「B 未挂回」）；把"挂回分组"从"取消归档"里独立出来后 **22/22**、单元 **41/41**，并新增两条反例断言（B 的归档状态不得改变；平时不重挂）。
- **2026-10-07 本机装机复核**：装入 desktop 后完全重启应用，实测四项齐备、台账于启动时刻写出、用户现有手动归档一条未动；用户随后在真机上跑通「删除工作区 → 重新添加」场景。

## 6. 隐私与发布状态

- 本仓库**本地署名**：`WindFromKadath <294740142+WindFromKadath@users.noreply.github.com>`（2026-10-07 设置，知识库「隐私检查与提交方案」§2）。
- 隐私检查工具已复制到 [.privacy-tools/](.privacy-tools/)（脚本 + 公共规则 + Hook 模板，**Hook 未启用**）；报告与例外见该目录的 README 与 VERIFICATION。
- 公开范围：**public + MIT**（用户 2026-10-07 决定）；默认分支 `main`。
- **已公开**：<https://github.com/WindFromKadath/dsh-plugin-workspace-archive>（2026-10-07 创建并首次推送；署名 noreply、GitHub 识别许可证为 MIT、topics 已写入；**仓库简介（About）2026-10-08 改为中文**；远端 HEAD 与本地一致）。
- 已按知识库流程执行：脱敏（本机路径 / 用户名 / 会话 slug → 占位符）→ 改写全部本地历史（私人邮箱与旧内容）→ 检查只剩工具自身 1 项误报 → 建仓推送 → 回读核验。完整记录见 [.privacy-tools/VERIFICATION.md](.privacy-tools/VERIFICATION.md)。
- 旧的脱敏前历史只存在于**仓库外**的受控 bundle 备份里，**不要**从它推送任何分支。
- **平台语言（本项目特例）**：经用户 2026-10-08 批准，本项目**偏离**知识库 2026-10-04 的「GitHub 倾向英文 / `README.md` 为 English 必需主入口」约定 —— `README.md` 是**中文主入口**、`README.en.md` 是英文互链，GitHub 仓库简介（About）也用中文，理由是 DSH 插件的受众主要是国内用户。该偏离只针对本项目，不推广到其它仓库。
- **npm 已发布**：`dsh-plugin-workspace-archive@0.1.0`（2026-10-08，走**分阶段发布 + 网页通行密钥批准**；`latest=0.1.0`、npmmirror 已同步、tarball sha1 与本地打包一致）。明细见 [.privacy-tools/VERIFICATION.md](.privacy-tools/VERIFICATION.md) §6。
- **可检索性**：关键词含生态通用的 `dsh-plugin`（+ `deepseek-harness`/`cordis`/`workspace`/`session`/`archive`），GitHub topic 也带 `dsh-plugin`；**npm 搜索索引对新包有滞后**（发布后数分钟仍未收录，待复检）。DSH 官方**没有**内置市场/按话题检索，发现通道是 npm 搜索 + 第三方目录。

## 7. 待办

- 需求①的接入决策（F006）：默认不复刻，如需接入只评估现成插件的兼容性与启用方式。
- `docs/recon/` 里仍有一些**由本机路径折叠出的 slug 形态**已统一替换为占位符；若将来补充新的勘察记录，同样不要写回真实路径。
