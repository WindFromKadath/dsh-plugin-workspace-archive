# 04 — plugin-1 先例与宿主知识勘察（针对 plugin-2 需求 ①自动命名 / ②工作区删除后归档恢复）

> **这份文件是什么**：对 `<branch-repo>`（`dsh-plugin-branch`）的**只读**勘察，回答"①②能不能做、能借什么、会踩什么"。
> **勘察方式**：只读 plugin-1 的文档/代码/真机记录 + 只读宿主安装树（`app.asar` 内的 `@deepseek-ai/*` 源码与 README）+ 只读本机 `$DSH_HOME`（profiles / storages / sessions 日志解码）。
> **纪律声明**：**未运行 plugin-1 的任何测试或脚本**；未修改 plugin-1 与 profile 的任何文件；本次唯一的写入就是本文件。
> **标注约定**：【事实】= 有代码/日志/文档出处；【推断】= 由事实推出的结论，尚未实测；【未找到证据】= 明确查过但没有。
> **路径占位**：`$DSH_HOME` = 本机 DSH 主目录（含用户名，按 plugin-1 纪律不写实名）。

---

## 0. 结论先行

| # | 结论 | 对 plugin-2 的意义 |
|---|---|---|
| 1 | **改官方会话标题已被 plugin-1 真机验证**：三条降级路径（官方 `sessionController.rename` → 活会话 `append('session/title')` → `sessionPersistence.open(id,'write')`），冷节点也能改，地面真值到日志级（A-58 §V26） | ①的"写名字"这一半**不需要重新发明**，可直接照抄 `branch_rename` 的实现 |
| 2 | **官方本来就有一套 LLM 自动命名**：`@deepseek-ai/dsh-session-title` + `@deepseek-ai/dsh-session-title-first-prompt-llm`，随 `dsh-base` 装在**所有** profile（desktop/trial/branch-e2e），用 `ctx.llm`（`purpose:'session-title'`）生成标题 | ①不是"造新能力"，而是"**替换/补足官方没生效的那一环**"；但也意味着必须先确认官方那条为什么没生效 |
| 3 | **本机实测：官方 LLM 标题提供方"排了队但没落地"**。plugin-2 当前 6 个会话日志里，每个都**只有一条** `session/title`，`source.kind = "fallback"`（= 首条用户消息前 5 词 / ≤40 字节的确定性截断，如 `"你是在做**本地先例与宿主知"`）。5 个 subagent 会话**连请求都没排**（0 条 `session/title-llm-request`）；**只有顶层父会话排了一次**（`seq=15`，`titleProvider: "session-title-first-prompt-llm"`，`route: {provider:"opencode-go", model:"deepseek-v4.1-flash"}`），但**至今没有任何 provider 来源的标题被接受** | ①有真实空白可填；但别把"官方会自动命名"当既有资产——它**已经装了、也确实会排队，只是没产出**（为什么，见 §5.3 P1） |
| 4 | **官方标题服务"至多一个提供方"是硬约束**：`ctx.sessionTitle.register(provider)` 第二次注册**立即抛错**，而 `dsh-base` 已经注册了 `first-prompt-llm` ⇒ plugin-2 **无法**用"再注册一个提供方"的方式接入 | ①的实现路线被压缩为：(a) 自己调 `ctx.llm` + 官方 rename；或 (b) 用 profile patch 替换官方那一行（配置改动，风险高） |
| 5 | **归档 = 可撤销的注册表集合，不是删除**：官方 `workspaceRegistry.archiveSession(id,{stopActivity?})` / `unarchiveSession(id)`，落点是 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds`（本机现有 **96** 条）；归档**不碰工作区归属**——archived 会话保留 `sessionIds` 槽位，取消归档回到原位 | ②的"归档/恢复"是**无损对偶**，语义上完全够用，不需要自建第二事实源 |
| 6 | **"文件夹没了"宿主自己有信号，但不对外暴露**：`workspaceRegistry.indexHeader()` 对每个会话 `realpath(cwd)` + `stat().isDirectory()`，失败者进入**私有**的 `invalidSessionPaths`（原因串如 `cwd '…' is not a directory`），并只在 `reportFilteredCandidates()` 里 `logger.warn`；实体 `entity.sessionIds` 也按"canonical cwd == workspace.path"过滤掉它们 | ②必须**自己判定**"文件夹消失"（查注册表 + 自检 `fs`），不能等宿主事件；同时要知道**侧栏此时会把这些会话甩进"未分组"** |
| 7 | **没有任何"工作区变更事件"**：`workspaceRegistry` 不发变更事件（全文件只有 `logger.warn` 与两个扩展点 `workspace/session-activity` waterfall / `workspace/session-stop` parallel） | ②的触发只能是**轮询/客户端 hook/启动时对账**三选一（有先例：V24 用"running→idle + 焦点"驱动 `sessions.refresh()`） |
| 8 | **plugin-1 从未调用过 `ctx.llm`**：`ctx.llm` 在 BLOCKS.md 里明确标 🟡「未使用」；它的"摘要器"是**一个会话节点**（V29），不是 API 封装 | ①若要走"自己调 LLM"，plugin-2 是**第一处**用到 `ctx.llm` 的代码，**没有可抄的封装**，只能抄官方 `dsh-session-title-llm` 的调用口径 |

---

## 1. plugin-1 已实测过的、与①②直接相关的能力

### 1.1 能不能改官方会话标题 —— ✅ 能，三条路都实测过

| 能力 | 出处 | 细节 |
|---|---|---|
| 改标题工具 `branch_rename({branch,title})` | `plugin-1/lib/index.js:1506-1592` | 【事实】降级顺序：① `ctx.get('sessionController').rename({sessionId,title})`（**官方会自己 resume 会话，冷节点也能改**，与 GUI 会话菜单同一条路）→ ② 活会话 `session.append('session/title', …)` → ③ `ctx.get('sessionPersistence').open(id,'write')` → `read()` 取末尾 seq → `append([{type:'session/title',seq,time,data}])` → `flush()` → `close()`（headless 可用） |
| 标题事件载荷契约 | `lib/index.js:394-396`（`appendTitleEvent`） | 【事实】`{ title, messageSeqs: [], source: { kind: 'user' } }`。文档原话：**"用户来源的标题会钉住会话"**——自动命名从此不再为它排期 |
| 真机地面真值 | `.verify/v26-rename-and-filter.txt:6-22`；`docs/ASSUMPTIONS.md:88`（A-58 ✅） | 【事实】节点日志标题序列变成 `[…,"V26-旧名","V26-主线命名"]`；离线冒烟覆盖三条路径 + 三种拒绝（115 次服务调用） |
| 建节点时钉标题 | `lib/index.js:966,1016,1636,1655` | 【事实】`branch_subfork` / `branch_link` 建完就 `appendTitleEvent(child,title)`，让子会话不再与源会话同题 |
| 冷节点能不能改 | `docs/ASSUMPTIONS.md:88`、`lib/index.js:1542-1553` | 【事实】能（官方 rename 自己 resume）。**但 headless 下对"刚建出来的 link 节点"改名失败**，见 §3.1（A-74 ❌） |

### 1.2 怎么列出会话 / 某工作区的会话 —— ✅ 有两条现成路

| 手段 | 出处 | 语义 |
|---|---|---|
| `sessionQuery.filterSessions([{kind:'parent', values:[sid]}])` | `lib/index.js:1311`、`docs/ASSUMPTIONS.md:57`（A-27 ✅）、`:102`（A-78 🟡） | 【事实】列出**直接子会话**（store fork 与 GUI 菜单 fork 同含）；`record.header` 带 `id/origin/cwd/createdAt`，`record.live`/`record.persisted` 也可读（`lib/index.js:1316-1322`） |
| `sessionQuery` 的其他谓词 | `docs/PLAN.md:592`、`docs/ASSUMPTIONS.md:102` | 【事实（契约级）】`filterSessions` 谓词含 **`id` / `cwd` / `created-at` / `parent` / `availability`**；另有 **`listSessions()`**、`observeSession()`（订阅会话变化，**从未用过**）、`readSurface()`、`filterEvents(sessionId, {type,surface,seq,time,text})`（每次限一个会话，跨会话要 `listSessions()` + 并发） |
| `workspaceRegistry.list()` → `entity.sessionIds` | `lib/index.js:557-569`（`currentWorkspace`）、`:583-593`（`attachToWorkspace`） | 【事实】plugin-1 用它做"这个对话属于哪个工作区"（先按 `sessionIds.includes(parent)` 命中，再按 `path === source.header.cwd`），并 `workspace.attachSession(childId)` 把新会话登记进项目 |
| 本机地面真值 | `$DSH_HOME/storages/workspace.json`（本次勘察解码） | 【事实】结构：`global.archivedSessionIds`（96 条）、`global.workspaceIds`、`tables.workspaces.<uuid>` = `{path,title,sessionIds,createdAt,updatedAt}`；本机 3 个工作区（plugin-1 有 21 个会话、plugin-2 有 1 个） |

> ⚠️ **没有找到** plugin-1 用过"按工作区一次性列出全部会话"的 API（它的 `branch_list` 只列**本对话的**直系子节点）。②要的"某文件夹下的全部对话"最接近的官方面是 `workspaceRegistry.list()[i].sessionIds` 与 `filterSessions({kind:'cwd'})`——**后者只有契约级证据**（A-78 🟡，未实测）。

### 1.3 归档节点的语义与落点 —— ✅ 实测到宿主注册表级

| 项 | 出处 | 内容 |
|---|---|---|
| 官方动作 | `lib/client.js:932,939`；`AGENTS.md:230`；`docs/ASSUMPTIONS.md:85`（A-55 ✅） | 【事实】客户端 `ctx.get('uiWorkspace').archiveSession(id,{stopActivity?})` / `unarchiveSession(id)`，请求落到宿主 `workspace/archiveSession` |
| 落点 | `.verify/v25-archive-nodes.txt:18-20,29-33`；`.verify/archive-nodes-drive.mjs:248-256` | 【事实】宿主注册表 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds` 真的加入/移除该 id（驱动直接读文件作地面真值） |
| 没有"真删除" | `AGENTS.md:329`；`docs/PLAN.md:713` | 【事实】宿主 `sessionController` 远端只有 list/search/create/selectModel/rename/fork/prompt/cancel/page/follow/projections/control，**没有 delete**；官方语义只有归档（可恢复）。"真删除"被产品决策**暂停** |
| 被拒的情形 | `AGENTS.md:230`；`.verify/v26-…:32-33` | 【事实】会话仍有在跑的工作时官方拒绝，面板要内联显示原因并给「停止并归档」第二步（即 `{stopActivity:true}`） |
| 宿主侧更精确的语义（本次新取，**不在 plugin-1 内**） | `app.asar:dsh/node_modules/@deepseek-ai/dsh-workspace/lib/types/index.js:254-326` | 【事实】① archive 前若未给 `stopActivity`，会走 `workspace/session-activity` waterfall，**任何上报的活动都会先抛 `WorkspaceActiveSessionError`，一个字节都不写**；② archive 会在**同一次持久写**里**丢掉该会话的 pin**（置顶与归档互斥）；③ **归档不碰工作区归属**——archived 会话保留 `sessionIds` 槽，"取消归档即回到原位"；④ `unarchiveSession` 不做会话存在性检查（移除 id 不会引入未知 id），所以**会话已消失也能取消归档** |

### 1.4 有没有现成的"摘要器"实现、它怎么调 LLM

plugin-1 有**两种**"总结"，但**都不是 LLM API 封装**：

| 形态 | 出处 | 说明 |
|---|---|---|
| **A. 实时总结节点**（V29，唯一实测过的"总结"） | `.verify/v29-live-summarizer.txt`；`AGENTS.md:181-186,297`；`docs/ASSUMPTIONS.md:96`（A-72 ✅） | 【事实】做法是**造一个 link 节点**，用 `branch_link(title='主线实时总结')` → `branch_say(节点,"产出五段式总结；收到「刷新」时用 branch_read(父, wait=false) 只报增量")` → `branch_read(wait,120s)` 取回。节点自己产出 1641 字符五段式总结；刷新时能读到**父级在途轮**的内容 |
| **B. `ctx.llm` 二次调用** | `plugin-1/docs/BLOCKS.md:149,256`；`docs/PLAN.md:707` | 【事实】**从来没写过**：BLOCKS 把 `ctx.llm` 标为 🟡「未使用」，PLAN §12.3 把它列为 M3 的**未决**选项（"纯文本规则 vs `ctx.llm` 二次调用"） |
| **C. 官方现成的 LLM 标题生成器**（本次新取，**plugin-1 完全没提过**） | `app.asar:…/dsh-session-title-llm/README.zh.md`；`…/dsh-session-title/README.zh.md` | 【事实】`dsh-session-title-llm` 就是"把选中的用户消息发给 LLM 生成简短标题"的**共享策略库**：它校验配置、解析路由、把消息封装成 JSON、按 `maxInputBytes` 限长、追加一条**仅日志**的 `session/title-llm-request` 事件、然后**通过 `ctx.llm` 流式生成**（封套带 `purpose:'session-title'`，DeepSeek 适配器据此**关闭思考**）；工具调用/空输出/非 stop 结束原因一律拒绝。随包提供方：`dsh-session-title-first-prompt-llm`（按首条消息）与 `…-all-prompts-llm`（按全部消息） |

**②④最关键的三条官方标题契约**（`app.asar:…/dsh-session-title/README.zh.md`，全部【事实】）：

- 标题有**三个来源，最新者胜**：内置回退（首条合格用户消息的前若干词）、已注册提供方、显式 `rename()`；**只有人类 `user/message` 事件的文本块**算合格输入，空/非文本提示词会等后续合格输入。
- **用户来源的最新标题会"钉住"会话**——后续用户消息**不再安排自动修订**，只有显式 `refresh()` 才能解钉。
- 服务面：`ctx.sessionTitle.register(provider)`（**至多一个，第二次注册立即抛错**）、`get(session)`、`foldSessionTitle(events)`、`refresh(session)`；标题是**纯日志状态**，`session/title` 事件，**永不进入模型输入**（不入 `deriveMessages()`/系统提示词/tool schema/请求前缀）。
- 提供方**只有在"带标记、由循环构建的请求"的确切路由与已记录 `request/header` 匹配时才启动**；较新的修订会取代并中止旧工作。
- **本机组合事实**：`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:55-66` 装了 `session-title`（`fallbackMaxWords:5`、`fallbackMaxBytes:40`、`maxTitleBytes:80`）与 `session-title-llm`（`first-prompt-llm`，`targetWords:5`、`targetCjkCharacters:10`、`maxInputBytes:4096`、`maxOutputTokens:64`、`timeoutMs:60000`）；desktop 的已物化 `cordis.yml:28-40` 与此逐字一致。**trial / branch-e2e 走同一份 `dsh-base`**（`profiles/trial/package.json` 的 `dsh.profile.bundles = [dsh-base, dsh-web-app]`）。

### 1.5 侧栏如何按工作区过滤显示 —— ✅ 实测两类过滤

| 过滤 | 出处 | 内容 |
|---|---|---|
| **官方「筛选会话」三档（归档过滤）** | `lib/client.js:57-89`；`docs/ASSUMPTIONS.md:89`（A-59 ✅）；`AGENTS.md:330` | 【事实】官方把档位存在 `dsh-client-ui-workspace` 的 `defineStore({persist:'dsh.workspace.view.v5'})` 里（`archivedFilter: default\|show\|only`），该 store **没有** `provideRoot` 给 slot → plugin-1 **读 `localStorage['dsh.workspace.view.v5']`**，每 2s 比较字符串（变了才通知）+ 窗口 focus 对齐；徽标/悬停段/面板三处同步 |
| **按工作区分组（不是过滤，是分组）** | `app.asar:…/dsh-client-ui-workspace/lib/client.js`（本次新取） | 【事实】官方 `groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder)`：把官方列表按工作区分组渲染，**没有被任何工作区记账的会话落进"未分组"（stray）** |
| **入口不能跟着档位消失** | `.verify/v26-…:32-33`；`docs/ASSUMPTIONS.md:90`（A-60 ✅） | 【事实】行尾 `⇄` 必须用"不过滤"的集合判断渲染，否则档位把节点全藏起来时用户够不到面板与提示 |
| 客户端行字段的坑 | `.verify/v25-…:24-28`；`AGENTS.md:327-328` | 【事实】客户端列表行的会话 id 字段叫 **`id`**（不是 `sessionId`）、父级叫 **`parentId`**（不是 `parentSessionId`）、标题是 `displayTitle`/`title`；用错字段会**静默拿到 `undefined`** |

---

## 2. 可复用的实现片段清单（文件 + 函数 + 作用）

> 全部位于 `plugin-1/`，均**纯 JS、无构建链**；照抄时把包名/前缀改掉即可（但注意 §3 的契约性坑）。

### 2.1 会话元数据「读」这一侧

| 片段 | 位置 | 作用 | 复用度 |
|---|---|---|---|
| `readTitleMap(query, ids)` | `lib/index.js:409-418` | 【事实】把 `readTitleSnapshots` 返回的 **settled result 数组**（不是 Map！）折叠成 `sessionId → 最新标题` | ★★★ 直接用 |
| `defaultSubforkTitle(query, sourceId)` | `lib/index.js:382-386` | 【事实】取源会话标题拼 `⤷ <title>`，80 字符封顶 | ★★ 参考（命名风格） |
| `currentWorkspace(ctx, pid, source)` / `currentWorkspacePath` | `lib/index.js:557-574` | 【事实】按 `sessionIds.includes()` 再按 `path === header.cwd` 找本对话所属工作区；无 `workspaceRegistry` 时返回 `undefined`（不报错） | ★★★ **②的入口** |
| `filterSessions([{kind:'parent'}])` + `record.header.*` 用法 | `lib/index.js:1311-1322` | 【事实】列直系子会话并读 `id/origin/cwd/createdAt/live/persisted` | ★★★ ②按 cwd 列会话的同款写法 |
| `foldTurnStatus(events)` | `lib/index.js:307-320` | 【事实】从自有事件折叠"运行中 / 最后结束原因"，**不依赖 projection 服务** | ★★ ①判断"一轮结束"可参考 |
| `messageOf(event)` / `collectRecent(events,limit)` / `textOf(blocks)` | `lib/index.js:243-290` | 【事实】把 `user/message`（裸载荷）与 `assistant/message`（包一层 `message`）两种形状统一成 `{role,text}`，再取尾部 N 条 | ★★★ **①"总结对话内容"的取料函数** |

### 2.2 会话元数据「写」这一侧

| 片段 | 位置 | 作用 | 复用度 |
|---|---|---|---|
| `appendTitleEvent(session, title)` | `lib/index.js:394-396` | 【事实】活会话钉标题的标准载荷 | ★★★ 直接用 |
| `branch_rename` 的三档降级 | `lib/index.js:1536-1585` | 【事实】官方 rename → 活会话 append → `sessionPersistence.open(id,'write')`+`read()`取末尾 seq+`append`+`flush`+`close`（**别用 `create`**，那是新建） | ★★★ **①的核心** |
| `attachToWorkspace(ctx, childId, pid, source)` | `lib/index.js:583-593` | 【事实】把会话登记进工作区（幂等、best-effort，失败也不影响会话可用） | ★★ ②对账时可能要用 |
| 冷节点物化事务（create→append→flush→close） | `lib/index.js`（`branch_link` 内，`:1632-1690`）；`AGENTS.md:319-320` | 【事实】`ctx.sessions.fork` 的产物**不持久化**，`ctx.sessions.flush` 是静默空操作；必须自己物化 | ★★ 仅当 ①/② 需要造节点 |
| 模型路由解析 `resolveModelRoute(ctx, source)` | `lib/index.js:671-684` | 【事实】`agentDefaultModel.currentSelection()` → 回退源会话最近 `request/header` 的 `config`；**冷启动缺路由会让子代理连 prompt 都装配不出来** | ★★ 若要造可继续节点 |

### 2.3 事件订阅、客户端席位、闸门

| 片段 | 位置 | 作用 | 复用度 |
|---|---|---|---|
| **running→idle 自动刷新（D2）** | `lib/client.js:795-846` | 【事实】订阅官方 `sessions.list`，检测"有人从 running 变 idle"→ 去抖调 `ctx.sessions.refresh()`；窗口 focus 也刷一次。**这是"一轮结束后做点事"的唯一实测先例** | ★★★ **①的触发样板** |
| 自建 store + `createStoreHook` + `useSyncExternalStore` 快照稳定纪律 | `lib/client.js:96-104,275-345,763-800` | 【事实】快照必须引用稳定（memo），否则无限重渲染 | ★★★ ①/②做任何清单都要 |
| 官方 filter 持久化值读取 `readArchivedFilter()` / `matchesArchivedFilter()` | `lib/client.js:57-89` | 【事实】读 `localStorage['dsh.workspace.view.v5'].archivedFilter`；`default`/`show`/`only` 三档判定 | ★★★ **②必须跟随它**，否则"归档后隐藏"的观感与官方不一致 |
| 归档 / 取消归档调用封装 | `lib/client.js:886-945`（`workspaceAction('archiveSession'…)` / `'unarchiveSession'`） | 【事实】走 `ctx.get('uiWorkspace')`，被拒时内联显示原因并给「停止并归档」第二步 | ★★★ **②的动作本体** |
| 五个官方 list slot 注册 | `lib/client.js:909-1000`；`AGENTS.md:225` | 【事实】`shell.overlay` / `sidebar.session.row.leading` / `.hover` ×2 / `sidebar.workspaces.session.row.action`；`inject = ['slots','locale','sessions']` | ★★ ①若要做界面点 |
| 审批闸门（派生式） | `lib/index.js:190-206`（`GOVERNANCE`）+ `:759-770`（`tools/pre-execute` 返回 `{kind:'ask'}`）+ `:809-834`（`maxDepth`/名额） | 【事实】名单**派生**自一张表，冒烟遍历所有注册工具断言"每个都必须 ask"，防漂移；headless 无审批通道时**失败关闭** | ★★★ plugin-2 若注册工具应照抄这套"防漂移" |
| `Config`（schemastery） | `lib/index.js:132-161` | 【事实】`export const Config = z.object({...})` + `resolveConfig`（`??` 默认 + TypeError，不调 `schema.parse`）；`--dump-config-schema` 可见 | ★★★ 直接照抄骨架 |
| 工具输出 schema 硬校验 | `AGENTS.md:333`；`docs/ASSUMPTIONS.md:75` | 【事实】`output.additionalProperties:false`：**返回未声明字段 → 整个调用报错，但副作用已发生** | ★★★ 加字段必须同步改 schema |

### 2.4 真机驱动（`.verify/*.mjs`）可当模板

| 驱动 | 位置 | 可借什么 |
|---|---|---|
| `archive-nodes-drive.mjs` | `plugin-1/.verify/archive-nodes-drive.mjs` | 【事实】CDP 无头 Chrome + 真实输入；①`connect/evaluate/jsonEval` 极简 CDP 客户端（`:42-70`）②**多帧 zstd 解码**（按魔数 `28 B5 2F FD` 切帧，`:72-84`）③**按 cwd 定位会话目录**（`:85-97`，`--${cwd.replace(/:/g,'').replace(/[\\/]/g,'-')}--`）④读 `workspace.json` 作归档地面真值（`:248-256`） |
| `rename-and-filter-drive.mjs` | `plugin-1/.verify/rename-and-filter-drive.mjs` | 【事实】让模型连续调 `branch_link`→`branch_rename`，再核对节点日志标题序列；用改写 `localStorage` 模拟官方换档 |
| `sidebar-visibility-drive.mjs` | 同上 | 【事实】"同一轮造两种会话 → 不刷新读侧栏 → 刷新再读 → 核对注册表"的判别式结构 |
| `dialogue-drive.mjs` | 同上 | 【事实】多轮节点对话的等待判据（"自有事件数增长 **且** 无在跑回合"） |
| `inspect-sessions.mjs` | `plugin-1/.verify/inspect-sessions.mjs` | 【事实】最小地面真值工具：解码最近 5 个会话日志，打印 `parent/origin/depth/seeded/继承事件数/自有 assistant/ branch_* 调用`（`:51-89`） |
| `md-lint.mjs` | `plugin-1/.verify/md-lint.mjs` | 【事实】Markdown 结构 lint（表格分隔行/列数、围栏、标签块并段），改文档后必跑（`AGENTS.md:264-271`） |

---

## 3. 踩过的坑 / 硬约束（必须提前知道）

### 3.1 标题修改是否可靠

| 坑 | 出处 | 事实 |
|---|---|---|
| **headless 下改不动"刚建出来的 link 节点"** | `AGENTS.md:304`；`docs/ASSUMPTIONS.md:98`（A-74 ❌）；`docs/STATUS.md:78` | 【事实】4 次、不同父会话、相隔 8 分钟全部失败：`session "…" is already owned by an active write handle`；而**前一天另一进程建的** link 节点改名**成功**（`via persistence`）。已排除：时间、父级是否被驱动、盘上锁文件（节点目录里只有 `session.v4.jsonl.zstd`）。**机制未查清**，怀疑 ownership 记录在 store 索引而非会话目录 |
| 用户来源标题 = 钉住，**没有**"取消钉住"的公开路径 | `app.asar:…/dsh-session-title/README.zh.md` | 【事实】"用户来源的最新标题会钉住会话——后续用户消息不再安排自动修订，显式 `refresh()` 仍是有意的解钉手段"；**"不经显式 refresh 就解钉回自动标题"不属于该服务** |
| 官方标题服务**至多一个提供方** | 同上（"已知限制"节） | 【事实】"注册表有意只接受一个实现，因此部署若要组合相互竞争的标题策略，必须编写一个**自行负责优先级**的提供方" |
| 提供方启动条件苛刻 | 同上 | 【事实】"只有在**带标记、由循环构建的请求**的确切路由与已记录 `request/header` 匹配时才启动"——这**可能**就是本机 LLM 标题没生效的原因（见 §5 探针 P1） |
| 官方 LLM 标题在本机**排了队但没落地** | 本次勘察：`$DSH_HOME/sessions/--…plugin-2--/*/session.v4.jsonl.zstd` | 【事实】6 个会话（5 个 subagent + 1 个父会话）各只有 1 条 `session/title`，`source.kind='fallback'`，`messageSeqs:[8]`，标题是首条用户消息的 40 字节截断。`session/title-llm-request` 计数：**5 个 subagent 会话 = 0**（提供方没排）；**父会话 = 1**，`seq=15`、`titleProvider:'session-title-first-prompt-llm'`、`route:{provider:'opencode-go',model:'deepseek-v4.1-flash'}`、`system` 是"5 词/10 CJK 字符、只用纯文本"的固定指令、`messages` 是把用户消息封装成 JSON。⇒ 提供方**确实会**被调度，但**没有任何 provider 来源的标题被接受**（同一日志里 fallback 在 seq=14，请求在 seq=15，之后再无 `session/title`） |
| 继承行为 | 同上 | 【事实】"fork 出的会话会**原样继承**种子中的标题事件"——所以子会话会带着父会话的标题事件开场（plugin-1 的 A-26 也观察到"继承来的两条旧标题（fallback/provider）被覆盖"） |

### 3.2 会话文件 / 目录名的契约（②的物理面）

【事实】本次勘察直接解码得到（**plugin-1 未记录过目录名规则**，它的驱动里有）：

- 会话日志落点：`$DSH_HOME/sessions/--<cwd 变形>--/<sessionId>/session.v4.jsonl.zstd`
  - `<cwd 变形>` = 绝对路径去掉 `:`、把 `\` 与 `/` 都换成 `-`，两侧加 `--`。例：`<repo>` → `--<repo-slug>--`。本机 `$DSH_HOME/sessions` 下 5 个目录，与 5 个项目路径一一对应（来源：`plugin-1/.verify/archive-nodes-drive.mjs:85`；本次实测目录列表一致）。
  - **目录名 == 会话 id**（本次实测：6 个目录名与各自 `session` 事件的 `id` 字段逐字相等）。
  - 【事实·反例提醒】id **不一定**带 `session-` 前缀：本次 plugin-2 的 5 个 subagent 会话 id 是**裸 uuid**（`556e108c-…`），只有父会话是 `session-eef9c4ef-…`。⇒ 别写死 `session-` 前缀正则。
  - 日志是**多帧拼接 zstd**：`zstdDecompressSync` **只解第一帧**——必须按 zstd 魔数（字节序列 `28 B5 2F FD`）切帧，否则漏读（`AGENTS.md:302`；驱动 `:72-84`）。
- `session` 头事件字段（本次实测）：`{type:'session', version:4, id, createdAt, cwd, parentSession?, isSeeded, origin?, delegationDepth, agentPreset}` —— **`cwd` 就是②判定归属的物理依据**。
- 工作区注册表：`$DSH_HOME/storages/workspace.json`（本次实测结构见 §1.2；官方声明：domain 名 **`workspace`**、version **2**、表 `workspaces`、单例 global 状态 —— `app.asar:…/dsh-workspace/lib/types/spec.js`）。

### 3.3 投影缓存一致性 / 侧栏可见性

| 坑 | 出处 | 事实 |
|---|---|---|
| 官方列表**只推 "live 会话 / 有 agent" 的创建** | `AGENTS.md:326`；`docs/ASSUMPTIONS.md:80`（A-50 ✅） | 【事实】宿主在会话创建与 `agent/created` 时 `ctx.emit('api-session/added', …)`；磁盘物化的冷会话**不推送**，必须重新拉 baseline（`ctx.sessions.refresh()`，`…/client.js:3258`） |
| **冷会话的摘要不带标题** | `AGENTS.md:326`；`docs/ASSUMPTIONS.md:81`（A-51 ✅） | 【事实】`summarizeCold(header)` 只给 `listFields`（parentSessionId/origin/cwd，**不含标题**）；标题只来自 `sessionProjectionCache`，未 engage 的会话没有缓存 → 侧栏显示「未命名」。**"日志里有标题"≠"列表有标题"** |
| 客户端组合**全有或全无** | `AGENTS.md:306`；`docs/ASSUMPTIONS.md:42`（A-12 ⚠️） | 【事实】`lib/client.js` 缺失/抛错会让**整个客户端组合激活失败**（不是单插件降级）；plugin-1 在 `apply` 外层包了 try/catch 把自己的失败限制在"界面点缺席 + 控制台报错" |
| 桌面客户端缓存到**重启** | `AGENTS.md:307`；`docs/ASSUMPTIONS.md:69`（A-39 ✅） | 【事实】`dsh-client-modules` 把"非客户端包"的判定缓存到应用重启；**刷新页面无效** |
| 宿主工具面在**启动时固定** | `AGENTS.md:296`；`docs/ASSUMPTIONS.md:95`（A-71 ✅） | 【事实】已跑着的宿主里，刚加的宿主工具报 `unknown tool`；**必须重启宿主/应用**才生效（2026-10-02 已实测确认） |
| 归档后侧栏**不隐藏**（至少 trial 0.1.7-rc.2） | `AGENTS.md:329`；`docs/ASSUMPTIONS.md:87`（A-57 ✅） | 【事实】对照实验：**官方自己的**「归档会话」按钮同样归档后行数不变、只弹 toast ⇒ 是官方行为。**桌面 0.2.0-rc.2 未复测** |
| 打开分支会话会 404 | `AGENTS.md:313` | 【事实】官方 deliverables 请求 `/api/changes.summary` 404，纯观感问题 |

### 3.4 写存储的顺序与所有权

| 坑 | 出处 | 事实 |
|---|---|---|
| store fork 产物**不持久化** | `AGENTS.md:319`；`docs/ASSUMPTIONS.md:54`（A-24 ✅） | 【事实】`ctx.sessions.fork` 的产物进程退出即消失；`ctx.sessions.flush` 是**静默空操作**（persistence 监听器只处理有写句柄的会话）→ 必须 `sessionPersistence.create→append→flush→close` |
| **写所有权是独占的** | `AGENTS.md:315`；`docs/ASSUMPTIONS.md:106`（A-66 ❌） | 【事实】报错原文 `session "…" is already owned by an active write handle`；触发典型是"上一轮派出的后台子代理还没结算"。**A-74 的失败信息与这条逐字相同**——②做批量归档/改名时要预期偶发拒绝并重试 |
| store fork 默认 id **跨进程碰撞** | `AGENTS.md:320`；`docs/ASSUMPTIONS.md:59`（A-29 ✅） | 【事实】省略第三参时 mint `session-<n>` 只对内存 store 去重，重启后撞已落盘旧 id（还会引发 headers conflict）→ **必须显式传 `session-<uuid>`** |
| `output.additionalProperties:false` 硬校验 | `AGENTS.md:333` | 【事实】返回值多一个未声明字段 → `Error: tool "X" returned invalid output`，**而副作用已经发生** |
| 参数 schema 不是标准 JSON Schema | `AGENTS.md:214` | 【事实】是 harness 的 `ParameterSchemaSpec`（每属性写 `required:true`）；注册表**拒绝含 `undefined` 的参数值** |
| 可选服务缺失要**明确报错**，不许静默降级 | `AGENTS.md:215` | 【事实】`ctx.get('sessionQuery')` 缺失时 plugin-1 是 throw（`lib/index.js:532-538`），只有 quota 计数那条显式降级并在文案里说明 |

### 3.5 headless 与 GUI 的差异

| 项 | 出处 | 事实 |
|---|---|---|
| `sessionController` / `workspaceRegistry` 只在 **web-app bundle** | `AGENTS.md:322`；`docs/ASSUMPTIONS.md:76`（A-46 ✅） | 【事实】desktop、trial 有；`branch-e2e`（`dsh-base + dsh-headless`，本次核实 `profiles/branch-e2e/package.json`）**两者都没有** ⇒ headless 只能走 primitive 且**无法登记进侧栏工作区**。⇒ **②的核心验证只能在 trial/desktop 做** |
| `--json` 的可用面相反 | `AGENTS.md:123,322` | 【事实】`trial`（web 应用 profile）**不接受 `--json`**，只能 GUI/CDP 驱动；headless 模板反过来支持 `--json` 事件流 |
| `--patch` 必须写在 app 参数**之前** | `AGENTS.md:176-177` | 【事实】写在后面会被当未知选项 |
| headless 一次性进程退出后，它派出的后台可继续子代理**永不结算** | `AGENTS.md:316`；`docs/ASSUMPTIONS.md:107`（A-67 ❌） | 【事实】日志长期停在 `1 start / 0 end`；**不能**把这个中间态当"跑完/失败"的结论 |
| headless `--session-id` 拒绝驱动**任何带 `parentSession` 的会话** | `AGENTS.md:321`；`docs/ASSUMPTIONS.md:55`（A-25 ❌） | 【事实】`assertAdoptable`；官方 GUI 菜单 fork 出的会话同样被拒 ⇒ sub-fork 续聊面只在 GUI |
| 节点读父级**一律 `wait:false`** | `AGENTS.md:297`；`docs/ASSUMPTIONS.md:96`（A-72 ✅） | 【事实】`wait:true` 会与父级**互锁**（父级此刻正等这个节点）→ 只能靠超时脱身。`wait:false` 能拿到"父级最后一条**已完成**回答 + 最近交换（**含在途轮**）" |
| 结算通知是**多块事件**（结论正文确实到达） | `AGENTS.md:295`；`docs/ASSUMPTIONS.md:94`（A-64 ✅） | 【事实】`#0` 信封 126 字符 + `#1` `Its closing message:` + `#2` 结论正文（V29 实测 1641 字符）。**旧文档"只有信封"是错的**，根因是只看了第一个正文块 |

### 3.6 pnpm shim 问题

【事实】`pnpm.cmd` shim 损坏（调 POSIX 脚本）→ **任何 `dsh plugin … add` 都失败**；真实入口 `node_modules\pnpm\bin\pnpm.mjs`（`AGENTS.md:80,318`；`docs/PLAN.md:343`；`docs/STATUS.md:79`）。plugin-1 的旁路安装 = 在 profile 的 `node_modules` 下建目录链接 + 把包名写进 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`（`AGENTS.md:201-203`；本机 trial/desktop 的 manifest 里就是 `"dsh-plugin-branch": "link:<branch-repo>"` 这种形态，本次已核实）。

---

## 4. plugin-1 的工程约定（plugin-2 若开工应当沿用）

| 项 | 事实 | 出处 |
|---|---|---|
| **形态** | 纯 JS、**无构建链**、零运行时依赖（`lib/index.js` 直接可跑）；`type: module`、`main: lib/index.js`；`exports` 含 `./client` | `AGENTS.md:17,51`；`package.json:5-16` |
| **双半结构** | 宿主半边 `lib/index.js`（`export const name/inject` + `apply(ctx,config)`，工具用 `defineTool`）+ 客户端半边 `lib/client.js`（**手写 classic script**：`window.__ModuleLoader__.load({id:'<包名逐字>', factory})`，尾部 `exports.apply/inject`） | `AGENTS.md:212,222-224`；`test/bundle.mjs:53-55` 会断言 load id 与包名逐字相等 |
| **客户端基座只允许 9 键** | `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`-dsh-client-store`、`-dsh-client-ui-slots`、`-dsh-client-ui-primitives`、`-dsh-client-ui-dockkit`（本插件只用前三个） | `AGENTS.md:223` |
| **manifest 约定** | `dsh.bundle.patch` → `cordis.patch.yml`；`dsh.client = {platform:'web', immediately:true, inject:[…]}`（`inject` 是**包名**列表=装载顺序；bundle 顶层 `exports.inject` 才是 Cordis **服务名**）；`files` 必须含 `lib` 与 `cordis.patch.yml` | `AGENTS.md:224`；`package.json:12-29`；`docs/PLAN.md:357` |
| **依赖成对声明** | `peerDependencies` 用宽范围（`>=0.1.7-rc.2 <0.3.0`）且**每个 peer 必须在 `devDependencies` 里有精确副本**（`test/bundle.mjs:36-39` 强制断言） | `AGENTS.md:52`；`package.json:30-39` |
| **测试三件（零依赖、不需要 pnpm install）** | ① `node --import ./test/register.mjs test/smoke.mjs` —— 真 `defineTool` + 真 `finalAssistantOutput` + 假 ctx，断言**确切的 service 调用序列**（plugin-1 现 79 项断言 / 客户端侧另 74~84 项）② `node --import ./test/register.mjs test/bundle.mjs` —— 清单/客户端声明形状 ③ `node test/client-smoke.mjs` —— 客户端半边离线冒烟（桩 `__ModuleLoader__` + 基座 9 键） | `AGENTS.md:96-99,339`；`test/smoke.mjs:1-9`、`test/bundle.mjs:1-59`、`test/client-smoke.mjs` |
| `test/register.mjs` + `test/resolve-dsh.mjs` 的作用 | 一个 dev-only ESM resolve hook：把 `@deepseek-ai/*`（以及仅 `bundle.mjs` 用的 `js-yaml`）映射到**已安装的 DSH profile**（锚点 `DSH_PROFILE_DIR`，默认 `$DSH_HOME\profiles\desktop`），这样 checkout 里**不需要本地 install** 也能 import 真包 | `test/resolve-dsh.mjs:1-45`；`test/register.mjs:1-5` |
| **文档维护纪律（plugin-2 建议照搬骨架）** | 先登记假设（⏳）→ 实现 → 补验证 → 改状态；状态四档 `✅ 已实测 / 🟡 契约已核实未实测 / ⏳ 未验证 / ❌ 已证伪`；**不许把"契约已核实"说成"已实测"** | `AGENTS.md:47-50,242-248` |
| **文档地图** | GOAL（做什么）/ BLOCKS（能力块+降级）/ PLAN（里程碑+环境工程约定 §8）/ ASSUMPTIONS（假设台账+V 系列记录）/ AUDIT（风险）/ RELATED（生态调研）/ STATUS（现状定格） | `AGENTS.md:25-37` |
| **Markdown 约定** | GFM 会把连续非空行并成一段 ⇒ "一行一条"必须写成列表项；表格上要空行、竖线一律 `\|`（反引号不保护竖线）；围栏前留空行；自查 `node .verify/md-lint.mjs` | `AGENTS.md:264-271` |
| **git 约定** | 提交信息 `<类型>: <一句话>`，类型 `feat/fix/docs/test/chore`；**永不提交** `.verify/*.jsonl\|*.yml\|*.txt`、凭证、`node_modules/` | `AGENTS.md:350-360` |

> 【事实】plugin-1 现规模：`lib/index.js` 2206 行、`lib/client.js` 1036 行、`test/smoke.mjs` 1347 行、`AGENTS.md` 360 行、`docs/ASSUMPTIONS.md` 595 行（80 条假设：✅65 / ❌7 / ⚠️3 / 🟡2 / ⏳3，`docs/STATUS.md:26`）。

---

## 5. 对 plugin-2 的直接影响

### 5.1 可实现性判断

| 需求 | 判断 | 依据 |
|---|---|---|
| **① 通过总结对话内容自动命名** | **可做，但必须选对路线；"接官方提供方"这条路基本被堵** | 【事实】写标题的三条路都被 plugin-1 真机验证过（§1.1）；`session/title` 是纯日志状态、永不进模型输入，写它成本极低。<br>【事实】官方**已有** LLM 标题能力（`dsh-session-title-llm` + `first-prompt-llm`，随 `dsh-base` 全 profile 装载），但 ① `ctx.sessionTitle.register` **至多一个**且已被占用；② 提供方**要求精确路由匹配**；③ 本机实测：父会话里提供方**确实排了请求**（`session/title-llm-request` @seq15），但**没有任何 provider 来源的标题被接受**，最终只有 fallback 截断。<br>【推断】最短可行路线 = **自己取料（`collectRecent`/`textOf`）+ 自己调一次 `ctx.llm` + 自己写 `session/title`**（或 `sessionController.rename`）。<br>【风险】用 `source:{kind:'user'}` 写标题会**永久钉住**该会话、掐掉官方自动修订；若官方 LLM 提供方本来该生效，这个写法会与之冲突（顺序：谁后写谁赢）。 |
| **② 文件夹删除 → 归档其中对话；文件夹加回 → 恢复** | **可做，且归档/恢复这半几乎零风险；难点全在"怎么知道文件夹没了"与"怎么拿到该文件夹的会话清单"** | 【事实】归档/取消归档是官方无损对偶，且**归档不动工作区归属**（回原位）；plugin-1 已把客户端调用封装好（`lib/client.js:886-945`）。<br>【事实】宿主**自己**就在做"cwd 不存在"的判定（`indexHeader` → `invalidSessionPaths` → `logger.warn`），但**不对外暴露**、也不发事件。<br>【事实】`workspaceRegistry` 没有任何变更事件；唯一的宿主扩展点是 `workspace/session-activity`（waterfall）与 `workspace/session-stop`（parallel）。<br>【推断】实现 = 客户端/宿主侧**轮询或启动对账**：`workspaceRegistry.list()` 拿 `path`+`sessionIds` → `fs` 自检 path 是否存在 → 消失就把该集合归档（并记住"是我归档的"），加回就 `unarchiveSession`。**注意别覆盖用户手动归档的会话**（要持久化"本插件归档过哪些 id"）。 |

### 5.2 建议直接复用的代码清单（按优先级）

1. **标题写入三档降级**：`plugin-1/lib/index.js:1536-1585`（`branch_rename.execute`）+ `:394-396`（`appendTitleEvent`）——①的写路径，含"别用 `create`"的注释级教训。
2. **会话取料与文本折叠**：`plugin-1/lib/index.js:243-290`（`textOf` / `messageOf` / `collectRecent`）——①喂给 LLM 的输入构造，已处理两种事件载荷形状。
3. **标题批量读取**：`plugin-1/lib/index.js:409-418`（`readTitleMap`）——settled-result 数组的坑已填。
4. **触发样板（running→idle + focus + 去抖）**：`plugin-1/lib/client.js:795-846`——①"一轮结束后自动命名"、②"定期对账"都可挂这里。
5. **归档/取消归档封装 + 官方三档跟随**：`plugin-1/lib/client.js:886-945` 与 `:57-89`（`readArchivedFilter` / `matchesArchivedFilter`）——②的动作与观感一致性。
6. **工作区归属解析**：`plugin-1/lib/index.js:557-593`（`currentWorkspace` / `attachToWorkspace`）。
7. **治理闸门骨架（派生式 + 防漂移断言）**：`plugin-1/lib/index.js:190-206,759-770,809-834`——要注册工具就照抄。
8. **真机驱动与地面真值工具**：`plugin-1/.verify/archive-nodes-drive.mjs`（CDP + 多帧 zstd 解码 + 直读 `workspace.json`）、`.verify/inspect-sessions.mjs`（日志体检）。**建议在 plugin-2 里重写一份，不要直接跑 plugin-1 的**（路径/标题常量与本项目无关）。
9. **工程骨架**：`package.json` 的形状、`test/register.mjs` + `test/resolve-dsh.mjs`、`test/bundle.mjs` 的清单断言、`cordis.patch.yml` 的行式（`plugin-1/cordis.patch.yml`）。

### 5.3 必须先补的验证探针（开工前，按顺序）

| # | 探针 | 判据 / 期望 | 为什么必须先做 |
|---|---|---|---|
| **P1** | **官方 LLM 标题提供方为什么"排了队却不落地"？** 在 desktop 造一个新会话（首条用户消息给足上下文），等 ≥90s，解码日志区分三件事：①有没有 `session/title-llm-request`（= 是否被调度）②有没有**新的** `session/title` 且 `source.kind !== 'fallback'`（= 是否被接受）③宿主客户端日志 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` 里有没有标题相关 warning | 三种结果对应三条路线：**(a)** 有请求、也有 provider 标题 ⇒ 官方那条本来能用，plugin-2 应"补足"而非"取代"；**(b)** 有请求、无 provider 标题（= 本机现状）⇒ 官方链路有稳定缺陷，①去修/替代它最有价值，且要查清是不是路由/提供方失败；**(c)** 连请求都没有 ⇒ 只对顶层会话有效，plugin-2 自己实现是唯一路径 | ①的路线完全取决于此；也决定"写 `kind:'user'` 会不会与官方提供方打架"（官方 README：用户来源标题会**钉住**会话并停止自动修订） |
| **P2** | **`ctx.llm` 在插件里能不能调**：env 门控探针（`DSH_*_PROBE=1`）在 headless 里 `ctx.get('llm')` 是否可解析、流式生成一次最小请求（封套带 `purpose:'session-title'`）并拿到文本 | 可解析 + 能取回文本 ⇒ ①走"自调 LLM"可行；否则只剩"让模型自己命名并调工具回报"（plugin-1 的 V26 模式） | 官方 `dsh-session-title-llm` 用的是同一条路，但**插件侧**未经证实 |
| **P3** | **写"非 user 来源"标题**：向一个会话追加 `session/title`，`source.kind` 分别试 `provider` / `model` / 自定义字符串，重启客户端看侧栏标题与"是否仍会自动修订" | 若 `provider` 被接受 ⇒ ①可选择**不钉住**会话的写法；若被拒 ⇒ 只能用 `user`（钉住） | 决定①是否会让用户失去官方自动命名 |
| **P4** | **`sessionQuery.filterSessions({kind:'cwd', values:[path]})` 真行为**（A-78 🟡 从未实测）：返回的是按 `header.cwd` 字面匹配还是按 canonical path？是否包含已归档会话？跨工作区是否串台 | 能按目录稳定列出该文件夹的全部会话（含归档）⇒ ②的"清单"有了 | ②的会话清单目前只有契约级证据；`workspaceRegistry.sessionIds` **会过滤掉** cwd 消失的会话（正好是②要抓的那批） |
| **P5** | **"文件夹消失"后的注册表行为是实时的还是只在启动重建？** 在 trial 里：造会话 → 记 `workspaceRegistry` 可见的成员 → 用另一个进程**改名/删除**该工作区目录 → 不重启观察 `list()[i].sessionIds` 与侧栏分组 → 再重启观察一次 | 若只在重启后收缩 ⇒ ②的检测必须自己 `fs` 自检（不能依赖 registry）；若实时收缩 ⇒ 可用"成员数变少"作信号 | 直接决定②的检测机制；也决定"侧栏会不会把会话甩进未分组" |
| **P6** | **归档批量操作的活动闸门实际表现**：对一个正在跑的会话调 `archiveSession`（不带 `stopActivity`）→ 期望 `workspace/session-active`；带 `stopActivity:true` → 期望落盘且工作被停 | 确认②在"会话正在跑"时该拒还是该停 | 宿主源码已给出契约（`index.js:263-302`），但本机未实测 |
| **P7** | **`domain/changed` 能否用于观测归档集变化**：订阅 `domain/changed`（domain = `workspace`），在 GUI 里手动归档一个会话，看事件是否带 `{domain:'workspace',table?/key?,operation}` | 能收到 ⇒ ②可以事件驱动，不必轮询 | A-77 只证明"storageDomain 已挂载 + 写序 + emit"，`workspace` domain 的订阅**未实测** |
| **P8** | **既有归档集不能被打乱**：本机 `global.archivedSessionIds` 已有 **96** 条（跨 3 个工作区）。②的"自动归档"必须能区分"我归档的"与"用户归档的"，否则"文件夹加回后自动恢复"会把用户手动归档的会话一起解除 | 需要持久化自己的归档账本（官方 domain / 自己的文件）并做集合对账 | 这是②最大的**用户可见风险**，不是技术风险 |
| **P9** | **插件包在 profile 里的安装旁路**：pnpm shim 仍坏 ⇒ 沿用 junction + manifest（`dependencies` + `dsh.profile.bundles`） | 能 `--dump-config` 看到自己的行、`--dump-config-schema` 看到 Config | 不解决则一切验证跑不起来 |

### 5.4 明确写下来的"未找到证据"

- 【未找到证据】plugin-1 从未调用过 `ctx.llm`、从未做过任何"LLM 摘要"；V29 的"总结器"是**节点**，不是 API。
- 【未找到证据】plugin-1 从未按**工作区/文件夹**枚举过会话（只有"按 parent 枚举子会话"与"按 sessionIds/cwd 定位本对话工作区"）。
- 【未找到证据】plugin-1 从未观察或使用过 `invalidSessionPaths` / `observeSession` / `readSurface` / `domain/changed`（后三者只在 PLAN §8.6 被列为"能力已勘察、未使用"）。
- 【未找到证据】宿主里没有"工作区被删除/丢失"的事件或客户端横幅；只有注册表的 `logger.warn`。
- 【未找到证据】官方没有会话删除接口（`sessionController` 远端无 delete；`workspaceRegistry.delete(id)` 删的是**工作区登记**，不是会话）。
- 【未找到证据（本次范围外）】`<app>\resources\app.asar\dsh\` 这个"checkout 目录"在本机**不存在**（只有 `resources\app.asar` 单文件）；本次对宿主源码的只读访问是通过 plugin-2 自己的 `.recon/asar.mjs`（`--list/--print/--grep`）完成的。
