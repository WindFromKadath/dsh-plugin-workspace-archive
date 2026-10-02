# DSH 相关插件检索报告（需求①自动命名 / 需求②工作区归档恢复）

> 检索对象：本机 DSH 桌面版 **0.2.0-rc.2**（`dshBuildCommit 04f392c9`，安装于 `<app>`，官方源码在 `resources\app.asar` 内 `/dsh/node_modules/@deepseek-ai/*`，约 250 个包）。
> 结论日期：2026-10-02。证据分级：**✅源码级**（我读到官方源码/README 原文或本机数据实测）、**🔎生态级**（第三方 README/元数据）、**⚠️未证实**。

---

## 0 一句话结论

| 需求 | 官方现状 | 生态现状 | 判定 |
|---|---|---|---|
| ① 总结对话 → 对话自己命名 | 只有"首条消息"命名（本机实测就是按 40 字节截断）；"全部用户消息"提供方在 npm 上有、**本机没装**；`refresh()`/`rename()` 现成 | **已有成熟实现**：`@weibaohui/dsh-smart-title` 等至少 6 个 | **红海，不要重做** |
| ② 工作区文件夹删除→自动归档、加回→自动恢复 | 归档是一等公民（存储+API+RPC+UI），`status()` 能判 `missing-dir`，但**官方从未把两者连起来**，且明确写"不会自动带回旧会话" | **零实现**：没有任何以"目录缺失"为触发的插件，只有手动归档或按时间/数量归档 | **真空白，可做** |

---

## 1 检索方法与"在 DSH 里怎么搜插件"

| 通道 | 说明 | 出处 |
|---|---|---|
| 本机已装载清单 | `$env:DSH_HOME\profiles\desktop\cordis.yml`（+ `cordis.patch.yml` 覆盖层、`package.json` 的 `dsh.profile.bundles`） | ✅本机 |
| 官方源码 | asar 内 `/dsh/node_modules/@deepseek-ai/<pkg>`；**官方包自带 `README.zh.md` 权威契约**，比代码更值得先读 | ✅ |
| 官方管理/安装通道 | `@deepseek-ai/dsh-plugin-manager`：**没有远程 marketplace / registry JSON**，分发即 **npm registry**；`OFFICIAL_NPM_REGISTRY='https://registry.npmjs.org/'`、`NPMMIRROR_REGISTRY='https://registry.npmmirror.com/'`，默认回退 npmmirror；spec 支持 包名 / 本地路径 / `github:owner/repo#sha` / tarball | ✅源码级（`dsh-plugin-manager/lib/types/registry.js`、`README.zh.md`） |
| 插件约定 | **不是包名前缀**，而是 `package.json` 的 `dsh.bundle`（+ 客户端 `dsh.client`、兼容性 `engines.dsh`）；缺 `dsh.bundle` 只会被当普通依赖并告警 | ✅源码级 + 🔎官方文档 |
| 可检索接口 | npm 搜索 API `https://registry.npmjs.org/-/v1/search?text=…`（`keywords:dsh-plugin` 命中约 6,578 个包；全文 `dsh-plugin` 约 282,181 条）、GitHub topic `dsh-plugin`、社区市场（dshmarket / dshbase / awesome-dsh-plugin / dshfind） | ✅ |
| 本机插件页/工具 | Web 侧栏 Plugins 页、只读设置页、`plugin_manager` 工具（只列**本 profile 已装**条目，`ask` 审批） | ✅ |

---

## 2 需求①：总结对话 → 对话自己命名

### 2.1 官方能力（现状）

- 已装载：`@deepseek-ai/dsh-session-title`（config `fallbackMaxWords:5 / fallbackMaxBytes:40 / maxTitleBytes:80`）+ `@deepseek-ai/dsh-session-title-first-prompt-llm`（`targetWords:5 / targetCjkCharacters:10 / maxInputBytes:4096 / maxOutputTokens:64 / timeoutMs:60000`）。
- 契约（`dsh-session-title/README.zh.md`，✅）：三个来源最新者胜 —— ①确定性回退（首条合格用户消息开头若干词）②注册的提供方 ③用户 `rename()`；**只有人类 `user/message` 的文本块合格**；标题写为 **`session/title`** 纯日志事件；投影单元 `title`（客户端可见）+ `titleInput`（host 专用，只留 first/last/count）；**绝不进入模型输入**；`ctx.sessionTitle.register(provider)` **至多一个提供方**；`refresh(session)` 是唯一的解钉重算入口。
- 代码级补充（`dsh-session-title/lib/index.js`，✅）：`provider.automatic ∈ {'first-prompt','all-prompts'}`；`all-prompts` 会在**每条合格用户消息**上排程，且自动工作只在主请求路由（`request/header`）落地后启动；provider 结果必须回报来自该请求的 `messageSeqs`。
- **本机实测**（✅ Lead 亲自解帧复核）：本会话日志 376 行，`session/title` **恰好 1 条** = `seq 14 {kind:"fallback"} "Chat，搜索当前的DSH中的相关插"`（即 `fallbackMaxBytes:40` 的确定性截断，"相关插件"被切掉），另有 **1 条 `session/title-llm-request`**（`seq 15`，route `opencode-go/deepseek-v4.1-flash`）——**LLM 标题请求确实发了，但没有被接受的 provider 标题落地**，最终显示的是回退值。这就是"今天并没有总结发生"的精确形态。
- 子报告 `01` 的全量统计（⚠️子代理实测未逐条复核）：本机 150 个含标题事件的 v4 会话中，59 个 fallback→LLM provider 走通、38 个只有 fallback、53 个含用户 rename，**没有任何会话出现两次 provider 标题**（印证"至多一次"）；124 条 LLM 请求 vs 99 条被接受 ⇒ 约 20% 静默回退。**子代理会话（`origin:'subagent'`）从不跑 LLM 标题**。
- 时机不是"轮次结束"：`user/message` → 排程 → 该轮**第一个 `request/header` 落地后**并发生成（`dsh-session-title/lib/index.js:379-393, 405-415`），必然早于本轮助手回答。
- **缺口确认**：`@deepseek-ai/dsh-session-title-all-prompts-llm`（npm 公开，最新 `0.2.0-rc.2`）**在本机构建里不存在**（asar 头部全文检索 `all-prompts` 0 命中、实现代码 0 命中）；即使装上，它也只吃 **user 消息**，不读助手回答。
- 可用缝隙（子报告 `01` §6.3，⚠️未由 Lead 复核）：provider 虽只收到合格用户消息，但**持有完整 `Session`**，可自行 `request.session.snapshotEvents()` 读全量日志；另有现成的 **`compaction/summary`**（本机 174 条，含 `## Primary Request and Intent` 章节）可作为整段对话摘要素材。官方 `refresh()` **没有任何调用方、也没有 UI 入口**（✅ 在 `dsh-api-session-controller` 内复核：只有 `rename` 被 RPC 链路调用）。


### 2.2 生态已有实现（🔎，均已核对 npm 元数据）

| 插件 | 能力 | 覆盖① |
|---|---|---|
| **`@weibaohui/dsh-smart-title`**（v0.1.8，声明 `engines.dsh >= 0.1.7-rc.2`，本机 0.2.0-rc.2 满足；但 DSH 安装时仍会校验 peer 兼容性，可能要求版本豁免） | 描述原文："每轮对话结束后对「用户消息 + 助手回答」的**完整转写**做一轮总结，标题跟随会话真实主题；首条消息即时出题、刷新节流与长会话冻结防无谓重刷、同题静默跳过、失败自动重试、用户手动改名不被覆盖、可选启动回填"；且 **安装时自动禁用内置 first-prompt 提供方** | **完全覆盖**（✅已核对 npm `latest` 元数据） |
| `dsh-session-title-pattern` | 大模型对整段对话总结，每 10 条重算，失败保留旧标题 | 覆盖 |
| `dsh-titlecraft` | 回合结束语义精修 + 原生重命名弹窗"AI 生成摘要→从摘要生成标题" | 覆盖 |
| `@klarkxy/dsh-current-title` / `@hanxu131/dsh-autotitle` / `lyxx999/Automatic-session-renaming-for-dsh` / `dsh-session-xc` / `dsh-session-title-format` | 标题生成/格式/手动 `/title` 等变体 | 部分覆盖 |
| `smart-session-title` | 只压缩首条 prompt | **无关①** |

> 互斥提醒：官方标题服务只接受**一个**提供方，这类插件彼此互斥，且需要接管/禁用内置 `first-prompt`。

### 2.3 判定与自研路径（若仍要自研）

**判定：需求①已被生态做透，重做价值低。** 若必须自研（例如要求落到官方 `session/title` 事件、复用官方投影），可行路径（✅ plugin-1 已真机验证过部分）：
`ctx.on('session/event')` 捕获轮次结束 → 从会话日志取 user+assistant 全文 → 自调 `ctx.llm` 总结 → `ctx.sessionTitle.rename(session, title)` 或 `sessionController.rename`。注意：`rename` 记的是 `user` 来源，会**永久钉住**该会话（正是想要的效果，但要显式设计）。

---

## 3 需求②：工作区文件夹删除→自动归档、加回→自动恢复

### 3.1 官方零件**齐全**（✅源码级）

| 零件 | 证据 |
|---|---|
| 归档是 storage 领域一等公民 | `workspace` 域 v2：`tables.workspaces[{path,title,sessionIds[],createdAt,updatedAt}]` + `global.{workspaceIds, archivedSessionIds, pinnedSessionIds, defaultWorkspaceId?, pendingMutation?}`（`dsh-workspace/README.zh.md`、`lib/index.js`、本机 `storages/workspace.json` 实测 `workspaceIds=3 / archived=96 / pinned=0`） |
| 幂等 API | `WorkspaceRegistry.archiveSession(id,{stopActivity})` / `unarchiveSession(id)` / `pinSession` / `unpinSession`（`lib/index.js:524/551`） |
| 活动拒绝与停止接缝 | 宿主事件 `workspace/session-activity`(waterfall) + `workspace/session-stop`(parallel)；有活动时抛 `WorkspaceActiveSessionError`，details 按 `turn/subagent/job/schedule` 列出 |
| 目录存在性判定 | `Workspace.status()` → `'ok' | 'missing-dir'`（`lib/index.js:156`、`lib/types/entity.js:116`） |
| Host RPC 全家桶 | `workspace/{create,delete,rename,insertBefore,insertSessionBefore,archiveSession,unarchiveSession,pinSession,unpinSession,initializeDefault}` + `workspace/follow` 流（baseline 后 `upsert/remove/order/archived/pinned`）；错误码 `workspace/session-active`、`workspace/not-found`、`workspace/invalid-path`、`workspace/name-conflict`、`workspace/move-invalid`（`dsh-api-workspace-controller`） |
| UI 已完整 | 行菜单"归档会话/取消归档"、三态滤镜 `隐藏已归档（默认）/全部对话（显示已归档）/仅已归档`、已归档行灰显"已归档对话暂时无法查看，请取消归档后查看"、归档 toast 带撤销、运行中会话弹"停止并归档此会话？"；插件席位 `sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`、`sidebar.session.row.leading`、`sidebar.session.row.hover`（`dsh-client-ui-workspace`） |

### 3.2 官方**明确不做**联动（✅README 原文）

- "目录无法校验的会话——没有记录目录，或目录被移动、删除——**无法加入，保持 Ungrouped**。"
- "**移除绝不删除数据**……这些会话变成 Ungrouped，而会话删除与文件夹移除是彼此独立且**尚未提供**的功能。"
- "**外部变更延迟可见**——如果另一进程删除或损坏目录，项目只能在下次刷新或重启后反映出来。"
- "**重新添加目录从空开始**——移除后再次添加同一目录会创建**空会话列表的新项目；旧会话不会自动回来**。"

### 3.3 全 asar 扫描的硬证据（子代理扫 11,470 个文件，✅）

- `missing-dir` **零消费方**：只有 4 处定义（`dsh-workspace/lib/index.js:156,158`、`types/entity.js:116,121`），无调用者。
- `archiveSession` **无任何自动调用**：18 处命中全是定义/RPC 管道/类型/UI 显式调用，**无定时器、无 watcher、无启动钩子**。
- 文件夹消失**不写 registry** ⇒ `domain/changed` / `workspace/follow` **永远收不到该信号**，只能轮询 `status()` 或自己 `fs.stat`。
- 目录名不可反推：`projectKey(cwd)` 把 `/ \ :` 折叠为 `-` 并包 `--…--`（`dsh-session-persistence-jsonl/lib/index.js:875-894`），注释自认 lossy；**绑定真源是会话头的 `cwd`**（实测首帧 `{"type":"session","version":4,…,"cwd":"<repo>"}`）。
- 本机实证孤儿：`~/.dsh/sessions/` 有 5 个目录，其中 `--…CourseSystem--`、`--…NewToLearn--` **不在注册表**里 —— 工作区记录被移除后，磁盘会话原样留着，没人归档也没人恢复。

### 3.4 生态现状（🔎）

| 插件 | 能力 | 与②的关系 |
|---|---|---|
| `dsh-tauri-session` | 在"删除工作区"菜单旁加**手动**"归档工作区"，一次归档该组全部会话 | 归档侧最接近，但**手动** |
| `dsh-workspace-kit` | 工作区级软归档+恢复 | 状态存**浏览器 localStorage**（视图层），手动 |
| `@mzzsfy/dsh-session-manager` | 自动归档引擎（超期） | 触发条件是**时间**；README 公开了直写 `archivedSessionIds` + 同步 `registry.state` 的绕行方案与失败矩阵 |
| `@linxin666/dsh-session-archive` | 自动归档（判据 `last-activity time, never creation time`） | 时间触发 |
| `dsh-plugin-archive-manager` | 按"不活跃 N 天 / 每工作区保留 M 条" | 规则触发 |
| `dsh-session-plus` / `dsh-archive-restore` / `dsh-chat-archive-manager` / `EugeneVl/dsh_session_folders` | 手动归档/恢复 | 非自动 |

**没有找到任何一个以"目录消失/回归"为触发的插件。**

### 3.5 判定与实现要点

**判定：需求②是真空白，但落地有四个硬约束（必须写进设计）。**

1. **只能轮询，且要抢在 prune 之前缓存**：文件夹消失不产生事件；更危险的是——文件夹消失后**下一次任何 workspace 写操作**的 prune 会把这些失效 id 从持久化 `record.sessionIds` 里**永久删除**（`dsh-workspace/lib/types/entity.js:141`）。所以插件必须在消失前/第一时间把"路径→会话 id"落到自己的 sidecar。
2. **恢复不能靠注册表身份**：重新添加目录会**新建空项目（新 workspaceId）**，旧会话不会回来；恢复必须靠自己记的 `路径 → [sessionId]` 台账。
3. **归档集合无来源标记**：`archivedSessionIds` 是纯 `string[]`，无时间戳、无来源 ⇒ **无法区分"用户手动归档"与"插件自动归档"**（本机 96 条里就混着用户对孤儿工作区的手动归档）。恢复时必须只 `unarchive` 自己 sidecar 里记过的交集。
4. **运行中会话会被拒**：`archiveSession(id)` 对有活动会话抛 `WorkspaceActiveSessionError`；自动归档应捕获后跳过（而不是 `stopActivity: true` 强行停掉用户正在跑的工作）。

建议骨架（✅挂点均已在源码中确认）：
启动全扫 + 定时轮询 `Workspace.status()`（去抖：连续 ≥3 次且 ≥60s 才判 missing）→ 判定 missing 前先写 sidecar → 逐个 `archiveSession(id)`（不带 `stopActivity`，拒绝则跳过）→ 目录回归后对新项目 `unarchiveSession(id)` 只恢复 sidecar∩（新 cwd 下）的会话。

---

## 4 检索中的两处更正（交叉复核结果）

1. **"官方归档是 one-way、没有取消归档 API" —— 不成立**（03b 报告该说法错误）。Lead 已在源码确认 `dsh-workspace/lib/index.js:551 unarchiveSession(sessionId)` 与 RPC `workspace/unarchiveSession`；UI 里也有"取消归档"与归档撤销 toast。恢复侧**可以直接用官方 API**，不必直写 storageDomain。
2. **`@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` 确实存在**（npm `0.1.6-alpha.1`，描述："Archived-session settings page: the registry-global archive set with one Unarchive action per row"），但**本机 0.2.0-rc.2 构建里没有**——属于"上游有、本地没装"，与 `all-prompts` 提供方同类。

> 热度口径警告：官方 `@deepseek-ai/*` 包月下载 150 万–250 万量级，被镜像/CI 放大，不能与社区包横向比；个别社区包下载量同样可疑，只能当弱信号。

---

## 5 分报告索引

| 文件 | 内容 |
|---|---|
| [00-lead-verified-facts.md](00-lead-verified-facts.md) | Lead 亲自核实的硬事实（含本机数据实测、官方契约原文） |
| [01-title-naming.md](01-title-naming.md) | 需求①深潜：官方标题管道全链路、时机/输入/落库、150 会话实测统计、4 个可挂点与不变量 |
| [02-workspace-session-archive.md](02-workspace-session-archive.md) | 需求②深潜：全 asar 11,470 文件扫描、绑定关系、陷阱、骨架、P1–P9 探针 |
| [03-ecosystem.md](03-ecosystem.md) | 生态检索（官方通道 + 91 个外链 + ①/② 占位判定） |
| [03b-ecosystem-npm.md](03b-ecosystem-npm.md) | npm registry 定向检索（10 条查询 + 7 份 packument README） |
| [04-plugin1-prior-art.md](04-plugin1-prior-art.md) | 本机 plugin-1（`dsh-plugin-branch`）先例、可复用代码、宿主坑 |
| （`.recon/asar.mjs`） | 本次使用的只读 asar 取值工具 |

> 说明：`01` 的关键结论（标题三来源、单提供方、`session/title` 事件、`title`/`titleInput` 投影、`all-prompts` 未装载、`refresh()` 无调用方）已由 Lead 用源码与解帧实测复核；`01` 中的全量统计数字（150 会话 / 20% 静默回退 / 子代理会话不跑标题）为子代理单方实测，未逐条复核。
