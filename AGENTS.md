# 开发项目协作规则

- 接手先确认用户当前要求，读取 README.md 和 tasks.csv 中相关任务行，再查看实际代码与必要的运行结果。历史总结中的方法判断要回查依据。
- README.md 记录目标、运行方式和已采纳取舍；tasks.csv 记录当前任务；实现与验证以代码和真实产物为依据。
- 本轮围绕一个明确的用户场景工作，保持改动可审查。范围、验收标准或关键取舍需要改变时，先说明影响，由用户决定。
- 作者视角记录作者自己的理解和疑点。可对照真实产物指出错误并建议修改，作者理解后回写；不得从任务完成推断作者已经掌握。
- 关键路径改变时，简述依据变化、选择和影响。存在作者学习目标时，用一个具体场景检查相关理解，避免只提供长篇总结。
- 在授权范围内自行完成可撤销的实现、相关检查和普通错误修复，不逐步索取“继续”确认。
- `done` 必须有场景验证证据，并填写对应版本和日期。未执行的检查、环境不可用或无法重现都标为待验证；不要通过削弱验收场景来凑通过。
- 优先更新已有文件和同一任务行。默认在对话中交接；新建 Markdown 要有独立交付用途，并从入口链接。
- 临时想法不写成已采纳决策；不要删除尚有引用的历史依据。多个执行者同时修改任务表时，先明确一位汇总者。
- 结案报告：实际改动、验证证据、达到的验收条件、剩余问题、下一步。

## 本项目的环境事实（写作与调试时直接用，不必重新勘查）

- 工作区 = `<repo>`（2026-10-07 由 `plugin-2` 改名，与 `package.json` 的 `name` 一致）；插件最终要能被本机 **DSH Desktop 0.2.0-rc.2** 装载。
- DSH 官方源码打包在 `<app>\resources\app.asar`（asar 内根 `dsh/`）。**只读**取用：
  `node .recon\asar.mjs --list|--print|--grep|--tree|--extract <asar> <asar内路径> [extra]`。
  官方包自带 `README.zh.md`，是优先于代码的契约来源。
- 运行时 profile：`$env:DSH_HOME\profiles\desktop\`（`cordis.yml` 装载清单、`cordis.patch.yml` 覆盖层、`package.json` 的 `dsh.profile.bundles`）。**只读**，除非用户明确要求做插件安装/启停。
- 运行时数据：`~/.dsh/sessions/--<slug>--/<sessionId>/session.v4.jsonl.zstd`（zstd **多帧**拼接，按 magic `28 b5 2f fd` 切帧）、`~/.dsh/storages/workspace.json`（`archivedSessionIds` 等）。**只读**。
- 插件约定：`package.json` 必须声明 `dsh.bundle.patch`；客户端半用 `dsh.client`；兼容性用 `engines.dsh`。DSH 没有远程插件市场，分发即 npm registry。
- 参考先例：`<branch-repo>`（`dsh-plugin-branch`，纯 JS 无构建链、79 项冒烟断言）——**只读**，可抄工程约定，不要改动它。
- **真机验证装置**：`npm run rm-test`（`.verify/real-machine.mjs` + `.verify/rm/cordis.yml`）。它在 `.verify/home` 这个临时 `DSH_HOME` 里启动一个**真** DSH 运行时（真 Loader、真会话持久化、真 storage-domain、真工作区注册表），跑"建工作区→建真会话→删目录→验归档→放回目录→验恢复"全场景，并核对用户真实 `~/.dsh` 未被改动。`@deepseek-ai/*` 由 `test/register.mjs` 的解析钩子提供；`.verify/home`、`.verify/proj` 是一次性运行时（已 gitignore）。**这是做真机验证的首选方式：不改 desktop profile、不碰用户数据。**
- **装载状态（2026-10-07 更新）：已重新装入 `desktop`**。装机：`node .verify/install-desktop.mjs`；装机前后只读核对：`--status`（依赖声明 / bundle 启用 / junction / patch 区域 / 台账五项）与 `node --import ./test/register.mjs .verify/diagnose-desktop-compose.mjs`（`$env:NPM_GLOBAL_ROOT = (npm root -g)`；实测 10 层全加载 / 0 跳过 / 198 条含本行）。**重启后实测**：四项齐备、台账于启动时刻写出、用户现有手动归档一条未动。同一天早些时候它曾被应用重写清单时掉失（见根 README「本机已知事项」）。**安装形态**：`.verify/install-desktop.mjs` 写入 ①`package.json` 的 `dependencies[name] = link:<本仓库>`（**插件页「已安装」列表就读这里**；只建 junction 不会出现——第一版就是这么白装的）②`dsh.profile.bundles` 追加本包名（页面上的启用开关）③`<profile>/node_modules/<name>` junction ④patch 层按 id 覆盖 `dryRun:false / confirmDelayMs:3000 / pollIntervalMs:300000 / watch:true`。备份 `package.json.bak-*-workspace-archive`、`cordis.patch.yml.bak-*-workspace-archive`。**卸载：`node .verify/install-desktop.mjs --uninstall`** —— 2026-10-07 已改为**逐项精准移除**（只摘本插件的依赖项、bundle 选择项与 patch 区域，且先备份当前文件）；旧版是"从备份整体还原 `package.json`"，实测会把之后新增的 `dshmarket` 一起弄丢，**不要再退回那种做法**。实测事实：① **HMR 不会热装载**（patch 层 insert、bundle 选择两次都等满 150/160 秒未生效）→ 必须重启 DSH，**改 `src/` 或 `lib/` 后同样要重启**；② app 启动时的 `removeLinkProjections` 只删指向它自己投影目录的链接，**不会**删我们的 junction；③ 本地 link 走不了 `dsh plugin --profile desktop`——launcher 明确拒绝 desktop profile。
- 插件真机自证：装载后第一轮对账会写 `~\.dsh\workspace-archive\ledger.json`（列出注册表里的工作区）。那是"装上了并且跑起来了"的最直接证据。
- **反应模型：事件驱动 + 分档确认 + 兜底轮询**（D011，2026-10-10 修订）。三个事实：① 宿主**有**注册表变更事件 `ctx.on('domain/changed', change)`（`change.table === 'workspaces'`，官方 controller 就这么订阅）→ 新增/删除项目秒级反应；② 宿主**没有**任何"目录消失"事件（`missing-dir` 零消费方、无 watcher、文件夹消失不写注册表）→ 目录侧只能自己给**父目录**挂 `fs.watch`（非递归，按当前跟踪路径集合增删）；③ 确认是**时间型**（`confirmDelayMs`，默认 3 秒）：第一次看到消失只开始计时，**并在窗口到点后自己再对账一次**（否则事件只来一次，会一直等到兜底轮询）。兜底轮询默认 5 分钟，只防 watcher/事件漏报；`confirmDelayMs: 0` = 发现即归档。
  - **④ 确认分两档 —— 权威事件不走窗口**（D014，2026-10-10。起因：用户报"删掉一个工作区后，会话先在侧栏散成「无项目」停一下才归档"）。判据分两类：`folder-missing` 是**一次 `stat` 的观测**，会抖（网络盘、改名中途）⇒ **永远走窗口**；`unregistered` 是**官方注册表说登记没了**（权威事件）⇒ 只要**本进程亲眼见过该路径登记过**就**不等窗口、立即归档**。
    - 闸门实现：引擎里维护 `seenRegistered`（`observe()` 对每个 `registry.list()` 的路径记一笔，键用 `pathKey`），以 `wasRegistered` 谓词传进 `policy.evaluate()`。本进程没见过 ⇒ 退回窗口。
    - **为什么闸门不可省**：插件刚启动、注册表还在 bootstrap 时，"不在 `list()` 里"与"被删了"**无法区分**；没有它会把还没铺出来的工作区**误归档**。官方其实有 `initialized` 标记来区分"合法空表"与"还没 bootstrap"（`dsh-workspace/lib/types/spec.d.ts:25-26` 🟡），但 `registry.list()` **不暴露**它 ⇒ 只能自己记"本进程见过"。
    - 实测（真定时器，`confirmDelayMs: 3000`）：删除登记 **3125 ms → 33 ms**；`folder-missing` **3120 ms → 3128 ms（不变，符合设计）**。证据：`tests/policy.test.mjs` 3 项 + `tests/engine.test.mjs` 1 项（真定时器量墙钟），**先红后绿**（`git stash push -- src` 后恰这 2 条判别性用例失败）。
- **手动归档工作区**（F020，2026-10-11）：新增模型可见工具 `workspace_archive`，把一个工作区的会话收进归档，或恢复此前由它归档的那些。
  - **官方侧的事实（先记清楚，别再重查）**：官方**没有**工作区级归档状态 —— `WorkspaceView` 无 `archived` 字段、RPC 无 `archiveWorkspace`、UI locale 无 `archive.workspace` 文案；能组合的只有"逐条 `archiveSession`"。
  - **归档 ≠ 隐藏**：官方客户端契约原文 *"**Every group shows**, except that the archived-only filter drops groups without visible members"*（`dsh-client-ui-workspace/.../tree.d.ts:138-139`）⇒ 归档整组会话后**工作区行仍在**（只是下面空了）。让工作区行消失的官方手段是「分组方式 → 单列表」（`SessionGroupBy = 'workspace' | 'workspace-tree' | 'flat'`，`stores.d.ts:14-15`）；显示层隐藏则已有 ≥3 家生态实现（`d0ublecl1ck/dsh-hide-empty-workspace`、`ice5kysl/dsh-workspace-kit`、`dsh-workspace-hide`）。
  - **D015：手动归档与自动归档必须是两份清单。** 台账新增 `manualArchivedSessionIds`，与"目录消失自动归档"的 `archivedSessionIds` **完全分开**。理由：手动归档是用户的明确意图，**不能被"目录消失又回来"的自动恢复顺手放出来**；反之自动归档也不该被手动恢复动到。**先红后绿**：把 `recordManualArchived` 临时改成写 `archivedSessionIds`（= 单一清单）后，恰 3 条判别性用例失败。
  - **D016：工具定义手写，不 import `defineTool`。** 零依赖是硬约束（D009）。`ToolsService.register` 收的是 `ToolDefinition`，其 `parameters` 就是**普通 JSON Schema**（`dsh-llm` 的 `ToolSchema.parameters: Record<string, unknown>`），`output.render` 只需返回 `[{ type: 'text', text }]` ⇒ 整份定义可零 import 手写。
    - ⚠️ 代价：绕过了 `defineTool` 的 schema 转换与**参数校验**，所以两条边界必须自己守：① `register()` 会调 `assertSupportedJsonSchema(output.schema)`，不受支持的关键字**当场抛错**；② `output.schema` 是对返回值的**硬校验**，多一个未声明字段整次调用就变 `returned invalid output`（`dsh-plugin-branch` V21 踩过）。
    - 守法是 `tests/tool.test.mjs`：**直接 import 宿主自己的** `assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue`（`@deepseek-ai/dsh-tools`）来验，而不是靠肉眼看子集。
    - 另加 fail-safe：`armTools` 里注册抛错只 `logger.warn`，**不拖垮插件**（其余能力与工具无关）。
  - **入口现状**：宿主工具（F020）+ 斜杠命令（F021），**仍无客户端半边**。**工作区行菜单已确认没有席位**（见下一条 F021 段）⇒ 想"点工作区菜单归档"，官方无路可走，只能 DOM 注入。
- **斜杠命令入口**（F021，2026-10-11）：`/archive-workspace <路径或标题>` 与 `/restore-workspace <路径或标题>`。
  - **为什么不用工作区行那个「…」菜单**：官方**没给工作区行菜单留席位**。全树枚举 `sidebar.workspaces.*` 只有 5 个 —— 根 `sidebar.workspaces` / `.directoryFlow` / **`.session.menu.item`（会话行的「…」菜单）** / `.session.row.action`（会话行悬停按钮）/ `sidebar.session.row.leading|.hover`；工作区行那个「重命名 / 删除工作区」是 `dsh-client-ui-workspace` **内联写死**的，类型层也没有对应组件（`session-actions/` 只有 Archive / Fork / Pin / Rename 这四个 **Session** 级动作）⇒ 想加进那个菜单只剩 **DOM 注入**（生态 `d0ublecl1ck/dsh-hide-empty-workspace` 就这么做，且自带「行标记失配」自检 = 它自己承认这条路脆），违反「不 fork 官方 UI」。
  - **D017：命令是"人触发"的第二入口，纯宿主侧。** `@deepseek-ai/dsh-commands` 契约原文 *"Plain-context definitions are **global**"*；`CommandDefinition` 全是宿主侧字段（name / description / input? / recordInput? / handler），handler 注释明写 *"Execute against the receiving agent **without sending the command to the model**"* ⇒ **零依赖、不需要客户端半边**（发现与渲染由官方 `dsh-client-ui-commands` 负责）。handler 只把 `rawInput` 交给 `engine.manualWorkspace`，**不复制任何归档/恢复逻辑**（台账分账 / D015 独立清单 / dryRun / 解析不唯一即拒绝 全部继承）；结果映射成 `CommandResult`（kind = success | error，加 text）。**恢复是免费的** —— 同一个引擎函数换个 action。
  - **⚠️ 教训（真机抓到、离线漏掉的 bug）**：`apply` 里**没有 `logger` 这个局部变量**（周围都用 `ctx?.logger`），`registerCommands(commands，engine，logger)` 求值即抛 `ReferenceError`，又被它自己的 try/catch 吞掉 ⇒ **命令静默不注册**。77 项离线断言全绿也漏掉它 —— 因为它们都没让 `apply` 拿到 `commands` 服务。修法：`apply` 顶部 `const logger = ctx?.logger`；回归用例在 `tests/command.test.mjs`。**推广的教训：`apply` 级别的接线性错误离线替身测不到，只有真机装置能抓。**
  - **真机装置已升级**：`.verify/rm/cordis.yml` 加挂 `@deepseek-ai/dsh-commands`；`real-machine.mjs` **阶段 7** = 3 条对照（分别证明*查询路径* / *定义形状* / *inject 接线*可用）+ 6 条断言（命令已注册、命令真能归档、真能恢复、未知工作区返回 error）。**排查手法值得复用**：先加对照证明**工具链**可用，再断言**我们的产物**存在 —— 否则分不清"我们没注册"与"查询方式不对"。
  - **🟡 未验证**：desktop GUI 输入框的命令弹窗是否真的列出这两条。装置无客户端/UI；契约上由 `dsh-client-ui-commands` 从宿主注册表取（`TypertRemoteService`），但**没有实测**，只能在重启后的 desktop 里验。
  - **真机装置对 `tools` 的缺口仍在**：`commands` 已挂，**`tools` 没挂** ⇒ `workspace_archive` 工具在真机里不注册，它的契约由 `tests/tool.test.mjs` 用宿主自己的校验器覆盖。要补上需给装置再加一行 `@deepseek-ai/dsh-tools`（待办）。
- **watcher 必须认「未知 filename」**（F023，2026-10-11 **已修**）：`fs.watch` 在**改文件夹名**时给的 `filename` 是**新名字**，而被跟踪的名字集合里只有旧名字。旧实现 `names.has(changed)` 直接丢弃该事件 ⇒ **插件不被叫醒** ⇒ 改名后要等兜底轮询（默认 5 分钟）才归档，与"删目录"（filename 恰是旧名字、立刻归档）行为不一致。
  - **真机实测**：修前台账 `missingSince` 是 `null`（没被叫醒）、该窗口内不归档；修后是时间戳 + 同一窗口内归档。**这同时证明**了根因 —— 修复只在"事件确实带着未知名字到达"时才可能生效。
  - **修法**：未知 filename 时只做一次**合并存活探测**（`schedulePresenceProbe` → 对该父目录下被跟踪的 path 各一次 `statDirectory`），**有缺失才** `notifyChange()`。只 stat、不触发对账、不写盘，所以父目录里出现无关条目不会被放大成高频对账（反例用例断言"无关条目 ⇒ 0 次动作、恰 1 次 stat"）。
  - ⚠️ **不能**简单改成"任何事件都 `notifyChange()`"：父目录（例：`D:\Coding\PersonalAction\`）下别的项目一有动静就会对账，而 `tick` 在无归档动作时**也会 `ledger.save()`**（`src/index.js:555`）⇒ 变成高频写盘。
  - **顺带修掉的第二个隐患**：watcher 只建一次，旧实现闭包捕获的是**建立时**的名字快照 ⇒ 之后新增/换名的同一父目录下工作区，按名字永远命中不了。现在 `watched` 每次 reconcile **整体替换**、闭包**每次事件重新取** ⇒ 不重建 watcher 也能立刻生效。
  - 证据：单元 `tests/engine.test.mjs` 3 项（**先红后绿** 78/81 → 81/81）；真机阶段 8 的预期**反过来**（修前断言"missingSince 是 null / 还没归档"，修后断言"被叫醒 + 同窗口内归档"）—— **51/51**。
- **「注册表成员数 ≠ 侧栏可见行数」—— 别再重查**（2026-10-11 实测）：一个工作区可以攒下很多**空白会话**（点过「+」/ 新建过会话但**从没发过话**），侧栏按官方规则**不画**它们。`dsh-api-session-controller` 里 `SessionListMetadata.blank` 的定义是 *"Whether the folded prefix contains **no turn**"*；客户端契约明写 *"**lists hide blank sessions**"* 与 *"browser shows **only the selected blank entry**"*（`client/sessions/lineage.d.ts:16-20`、`service.d.ts:33-35`）。
  - 实例（用户 2026-10-11 报"`已归档 8/8`，可侧栏只有 4 行"）：`Rust` 工作区注册表 **8** 个成员 = 4 条真对话（21-22 事件 / 15.7–16.1 KB / 末尾 `session/end-seed` / 有首条用户消息）+ **4 条空白会话**（**恰好 4 事件 / 319-326 字节 / 末尾 `approval/policy` / 无用户消息**）⇒ 侧栏正好 4 行，且 4 个标题逐字对上。
  - 后果：本插件报的 `已归档 N/N` 里 N 是**成员数**，会比侧栏行数大。**行为正确、零损失**（空白会话本就不可见）。
  - ⚠️ **不要去插件里"区分空白会话"**：宿主侧**没有**插件可用的 `blank` 位 —— `SessionListMetadata` 在 `session-projection` 侧（依赖它 = 破 D009 零依赖）；`sessionPersistence.list()` 只给 `eventCount` / `sizeBytes`，那是**代理指标**，与官方"前缀里有没有 turn"不是同一口径。勘察脚本见 `.recon/scan-workspace-sessions.mjs`（gitignore）。
- **恢复有两件事：取消归档（只对"本插件归档过的"）+ 挂回分组（对台账快照里全部缺席的成员）**（D012/D013，2026-10-07）：官方「归档」**不拆** `sessionIds` 槽位（所以"登记还在、目录一度缺失"时取消归档就回原位），但菜单「删除工作区 → 重新添加同一目录」会**新建一个空成员的项目** ⇒ 成员全部散成「无项目」。
  - policy 只在「该工作区**经历过一次消失**」时下发独立的 `attach` 动作，判据 = 台账 `missingSince` 非空 **或** 官方记录 id 与台账记下的 `workspaceId` 不同；**平时绝不下发**（否则会把用户手动移出工作区的会话又塞回去）。
  - `attach` 名单 = 台账快照里缺席的成员，**含在消失之前就已经归档的**（典型是用户自己手动归档的）：只调 `Workspace.attachSession`，**绝不碰 `archivedSessionIds`** —— 归档会话只是回到自己的分组，仍然隐藏。
  - `attachSession` 是**前插**，所以按**倒序**挂回才能保持原来的相对顺序；它自带 `cwd === record.path` 校验（`dsh-workspace/lib/index.js:111-129`），目录被改名等对不上的情形抛错 → 只记日志、继续处理其余会话。
  - 边界：插件只认**台账里记过的**会话，从不按 `cwd` 反查批量接管。
- **两条"看着该做"的能力做不到，别再重复调研**（2026-10-08，逐条源码依据见 [docs/recon/05-migration-and-multi-folder.md](docs/recon/05-migration-and-multi-folder.md)）：
  - **跨工作区迁移会话**（例：Rust → DeepSeekHarness）：官方**无通道** —— `attachSession` 要求 `cwd === 工作区路径`（`dsh-workspace/lib/index.js:111-129`）、`insertSessionBefore` 只能**组内排序**（`:130-147`）、官方客户端拖拽**只能同组**（`dsh-client-ui-workspace/lib/client.js:2545-2546`）、`fork` 落回**源**工作区（`dsh-api-session-controller/lib/types/commands.js:519-531`）。唯一实现方式是直写 `sessions/` 里的 header `cwd` —— **破本插件"只走官方 API"的红线**，且生态已有 `birdmanhj/dsh-mv-session`（需停机 + 重启）。
  - **一个工作区多文件夹**：官方沙盒策略是**单根**（`SandboxExecutionPolicy.workspaceRoot: string`，`dsh-sandbox/lib/types/index.d.ts:27-31`；可写根 = 该根 + 临时目录，`lib/index.js:166-173`；每轮根来自会话 cwd，`dsh-sandbox-policy/lib/index.js:141-148`），官方 ACP 层**明文拒绝** `additionalDirectories`（`dsh-acp/lib/index.js:1412`），且软链/junction 绕不过围栏（`dsh-fs-sandbox/lib/index.js:160` 每次写入重新规范化目标）。多根由第三方 `@chaoset/sandbox-extra-roots` 补，依赖它会破本插件"零依赖"。
  - **可用的官方子集已实现**（见下一条）。跨 cwd 的**真迁移**（T1）需要离线直写会话 header，**用户 2026-10-08 已放行**；方案、现成实现评估（生态 `dsh-mv-session` 因硬编码代际 0 文件名 `session.jsonl.zstd` 而**不可直接用**）与待勘察清单见 [docs/plan-session-migration.md](docs/plan-session-migration.md)。
- **「无项目 → 按 cwd 归位」已实现**（T0 / F013，2026-10-08，`src/adopt.js`）：官方 registry 只在**第一次启动**时按 `header.cwd` 归组（bootstrap 一次性），此后"会话落在「无项目」里、而 cwd 就是某个已登记工作区路径"没有任何官方通道能自愈。
  - 数据源全官方只读：`ctx.sessionPersistence.list()` → 每个已存会话的 `header.cwd`；`workspaceRegistry.list()` → 路径与成员表。**不读 `sessions/` 文件、不解 zstd 帧**。
  - 判据刻意收紧：**不在任何**工作区的成员表里 + `realpath(cwd)` 与工作区路径**精确相等**（不做前缀/父目录/子目录匹配）+ `cwd` 能解析；按 `createdAt` 升序下发（`attachSession` 是前插 → 结果才是"新的在前"）。
  - 只调官方 `Workspace.attachSession`，**绝不**碰 `archivedSessionIds`，失败逐条记日志；启动后**只跑一次**（`adoptDelayMs` 默认 5000），可用 `adoptUngrouped: false` 关闭，`dryRun` 下只记日志。
  - 归位后的会话进入下一轮健康台账快照，于是自动获得「目录消失→归档→回归→挂回」的保护。
  - 证据：单元 **48/48**（`tests/adopt.test.mjs` 7 项）；真机 **27/27**（装置阶段 1b 备料 + 阶段 6 断言），**先红后绿**（临时 `adoptUngrouped: false` → `FAIL T0 归位…` 26/27，还原后 27/27）。
- **junction 装载的插件不能 `import` 宿主包**（本机踩实）：profile 里 `node_modules/<插件>` 是 junction 指向本仓库时，Node 按**真实路径**解析嵌套 import，从 `dsh-plugin-workspace-archive\` 往上走够不到 `profiles\node_modules`，于是 `@deepseek-ai/schemastery` 之类直接 `ERR_MODULE_NOT_FOUND`，插件在 DSH 里装载失败（组合层一切正常、只有模块加载报错，而且**应用没有可读日志**，只能靠"插件没跑"倒推）。两条出路：**① 插件零外部依赖**（本项目选的路，见 D009）；② 把包装进 profile 的 node_modules 树里（pnpm 安装/复制），让它能沿目录树往上解析。`dsh-launch-environment` 只是环境快照，**没有**模块解析钩子；`test/register.mjs` 的钩子只在本地测试进程里有效，app 进程没有它。

## 危险操作边界（越界前必须先问用户）

- 不删除、不改名、不移动**任何真实工作区目录**；场景验证一律用一次性临时目录。
- 不写 `~/.dsh` 下官方 `storages/`、`sessions/` 里的任何文件；归档/恢复只走 `ctx.workspaceRegistry` 官方 API。本插件**自己的** sidecar 只允许写在 `$DSH_HOME/workspace-archive/`（`dshHomePath('workspace-archive', …)`）。
- 归档前必须先落 sidecar 台账；恢复只处理台账交集，**绝不能**批量 `unarchive` 用户手动归档的会话。
- 挂回分组只处理**台账快照里的缺席成员**，且**只在"该工作区经历过一次消失"时**下发（判据见上一条）；平时绝不下发。
- **按 `cwd` 反查只在「T0 归位」这一处被允许**，判据必须是"**不在任何**工作区成员表 + `realpath(cwd)` **精确等于**某工作区路径"，并可用 `adoptUngrouped: false` 关闭。除此之外**绝不允许**按 `cwd` 反查接管 —— 尤其在归档/恢复路径里（会把用户留在「无项目」的会话塞回去）。
- T1 的"离线直写会话 header"属于**独立工具**（用户 2026-10-08 放行）；本插件的**运行时代码仍然只走官方 API**，不得直写 `sessions/`、`storages/`。
- 挂回分组**不等于**取消归档：除了 `Workspace.attachSession`，**不得**触碰 `archivedSessionIds`；用户手动归档的会话只回到自己的分组，必须保持归档。
- 不修改 `app.asar`、不修改 profile、不给官方包打补丁。
- `.recon/` 是只读勘察用的一次性脚本与 asar 展开目录（已 gitignore）；不要把结论留在那里，结论进 `docs/`。
