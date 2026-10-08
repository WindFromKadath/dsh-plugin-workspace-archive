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
- **反应模型：事件驱动 + 时间确认 + 兜底轮询**（D011）。三个事实：① 宿主**有**注册表变更事件 `ctx.on('domain/changed', change)`（`change.table === 'workspaces'`，官方 controller 就这么订阅）→ 新增/删除项目秒级反应；② 宿主**没有**任何"目录消失"事件（`missing-dir` 零消费方、无 watcher、文件夹消失不写注册表）→ 目录侧只能自己给**父目录**挂 `fs.watch`（非递归，按当前跟踪路径集合增删）；③ 确认是**时间型**（`confirmDelayMs`，默认 3 秒）：第一次看到消失只开始计时，**并在窗口到点后自己再对账一次**（否则事件只来一次，会一直等到兜底轮询）。兜底轮询默认 5 分钟，只防 watcher/事件漏报；`confirmDelayMs: 0` = 发现即归档。
- **恢复有两件事：取消归档（只对"本插件归档过的"）+ 挂回分组（对台账快照里全部缺席的成员）**（D012/D013，2026-10-07）：官方「归档」**不拆** `sessionIds` 槽位（所以"登记还在、目录一度缺失"时取消归档就回原位），但菜单「删除工作区 → 重新添加同一目录」会**新建一个空成员的项目** ⇒ 成员全部散成「无项目」。
  - policy 只在「该工作区**经历过一次消失**」时下发独立的 `attach` 动作，判据 = 台账 `missingSince` 非空 **或** 官方记录 id 与台账记下的 `workspaceId` 不同；**平时绝不下发**（否则会把用户手动移出工作区的会话又塞回去）。
  - `attach` 名单 = 台账快照里缺席的成员，**含在消失之前就已经归档的**（典型是用户自己手动归档的）：只调 `Workspace.attachSession`，**绝不碰 `archivedSessionIds`** —— 归档会话只是回到自己的分组，仍然隐藏。
  - `attachSession` 是**前插**，所以按**倒序**挂回才能保持原来的相对顺序；它自带 `cwd === record.path` 校验（`dsh-workspace/lib/index.js:111-129`），目录被改名等对不上的情形抛错 → 只记日志、继续处理其余会话。
  - 边界：插件只认**台账里记过的**会话，从不按 `cwd` 反查批量接管。
- **两条"看着该做"的能力做不到，别再重复调研**（2026-10-08，逐条源码依据见 [docs/recon/05-migration-and-multi-folder.md](docs/recon/05-migration-and-multi-folder.md)）：
  - **跨工作区迁移会话**（例：Rust → DeepSeekHarness）：官方**无通道** —— `attachSession` 要求 `cwd === 工作区路径`（`dsh-workspace/lib/index.js:111-129`）、`insertSessionBefore` 只能**组内排序**（`:130-147`）、官方客户端拖拽**只能同组**（`dsh-client-ui-workspace/lib/client.js:2545-2546`）、`fork` 落回**源**工作区（`dsh-api-session-controller/lib/types/commands.js:519-531`）。唯一实现方式是直写 `sessions/` 里的 header `cwd` —— **破本插件"只走官方 API"的红线**，且生态已有 `birdmanhj/dsh-mv-session`（需停机 + 重启）。
  - **一个工作区多文件夹**：官方沙盒策略是**单根**（`SandboxExecutionPolicy.workspaceRoot: string`，`dsh-sandbox/lib/types/index.d.ts:27-31`；可写根 = 该根 + 临时目录，`lib/index.js:166-173`；每轮根来自会话 cwd，`dsh-sandbox-policy/lib/index.js:141-148`），官方 ACP 层**明文拒绝** `additionalDirectories`（`dsh-acp/lib/index.js:1412`），且软链/junction 绕不过围栏（`dsh-fs-sandbox/lib/index.js:160` 每次写入重新规范化目标）。多根由第三方 `@chaoset/sandbox-extra-roots` 补，依赖它会破本插件"零依赖"。
  - **可用且未实施的官方子集**："无项目 → 按 `cwd` 归位"（`header.cwd` 与某已登记工作区 realpath 等值 → `attachSession`）。
- **junction 装载的插件不能 `import` 宿主包**（本机踩实）：profile 里 `node_modules/<插件>` 是 junction 指向本仓库时，Node 按**真实路径**解析嵌套 import，从 `dsh-plugin-workspace-archive\` 往上走够不到 `profiles\node_modules`，于是 `@deepseek-ai/schemastery` 之类直接 `ERR_MODULE_NOT_FOUND`，插件在 DSH 里装载失败（组合层一切正常、只有模块加载报错，而且**应用没有可读日志**，只能靠"插件没跑"倒推）。两条出路：**① 插件零外部依赖**（本项目选的路，见 D009）；② 把包装进 profile 的 node_modules 树里（pnpm 安装/复制），让它能沿目录树往上解析。`dsh-launch-environment` 只是环境快照，**没有**模块解析钩子；`test/register.mjs` 的钩子只在本地测试进程里有效，app 进程没有它。

## 危险操作边界（越界前必须先问用户）

- 不删除、不改名、不移动**任何真实工作区目录**；场景验证一律用一次性临时目录。
- 不写 `~/.dsh` 下官方 `storages/`、`sessions/` 里的任何文件；归档/恢复只走 `ctx.workspaceRegistry` 官方 API。本插件**自己的** sidecar 只允许写在 `$DSH_HOME/workspace-archive/`（`dshHomePath('workspace-archive', …)`）。
- 归档前必须先落 sidecar 台账；恢复只处理台账交集，**绝不能**批量 `unarchive` 用户手动归档的会话。
- 挂回分组只处理**台账快照里的缺席成员**，且**只在"该工作区经历过一次消失"时**下发（判据见上一条）；平时绝不下发。**绝不**按 `cwd` 反查批量归组 —— 那会把用户故意留在「无项目」的会话也塞回去。
- 挂回分组**不等于**取消归档：除了 `Workspace.attachSession`，**不得**触碰 `archivedSessionIds`；用户手动归档的会话只回到自己的分组，必须保持归档。
- 不修改 `app.asar`、不修改 profile、不给官方包打补丁。
- `.recon/` 是只读勘察用的一次性脚本与 asar 展开目录（已 gitignore）；不要把结论留在那里，结论进 `docs/`。
