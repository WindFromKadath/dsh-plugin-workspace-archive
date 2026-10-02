# 需求① 深潜勘察：DSH 官方「会话标题 / 自动命名」机制

> 勘察对象：本机 DSH 桌面版 **0.2.0-rc.2**（`<app>`，官方源码打包在 `resources\app.asar`，asar 内虚拟根 `dsh/`）。
> 勘察方式：**纯只读**。asar 目录/文件读取、扩展的全量正则扫描、`~/.dsh` 会话日志解压分析。未修改任何配置、未安装任何依赖、未启动任何服务。
> 结论日期：2026-10-02。
> 证据分级：**✅源码级**（读到官方包内源码/类型/README 原文）、**✅本机实测**（本机 `.dsh` 运行数据统计）、**⚠️未证实**（有观察但缺确定因果证据）。

---

## 结论先行（TL;DR）

| 问题 | 结论 |
|---|---|
| 标题从哪来 | 三源「最新者胜」：① 确定性回退（**第一条合格人类消息**开头若干词截断）② 注册的提供方（LLM）③ 用户显式 `rename()` |
| 产生时机 | **不是**轮次结束，而是——用户消息落地 → 排程 → **该轮第一个 `request/header` 落地后**立刻异步并发跑，与助手的回答同时进行 |
| 是否只命名一次 | **本机构建下，LLM 自动命名每个会话至多一次**（first-prompt 节奏）。服务本身支持 `all-prompts`（每轮重命名）节奏，但**本机构建里没有任何实现该节奏的插件** |
| 输入是什么 | 服务只把**合格的人类 `user/message` 文本**交给 provider；**不含助手回答、不含工具结果**。但 provider 拿到了整个 `Session` 对象，可自行读取全量日志 |
| 失败如何回退 | 先写确定性回退标题（几乎必然成功），LLM 成功才覆盖；LLM 失败/超时/被取代 → **静默保留回退/旧标题**，只打一条 warn 日志 |
| 落库形态 | 纯日志事件 `session/title` + `session/title-llm-request`；投影单元 `title`（客户端可见）/ `titleInput`（host 专用）；持久化在 `session.v4.jsonl.zstd` 与 `storages/session_projcache/` |
| 客户端重命名 | 有。会话行「⋯」菜单 → 重命名（order 200）、标题双击、快捷键 `session.rename`（KeyG）→ RPC `session.rename` |
| 邻近插件有无现成"总结" | `compaction-basic` 的 `compaction/summary` **是真实的整段对话摘要**（含 `## Primary Request and Intent`），但只在触发压缩时产生；`turn-outline` 是截断预览；`session-stats` 只有数字；`session-log-deepseek` 是上传，与总结无关 |
| 需求①判定 | **部分覆盖**——"机制/落库/UI/重命名"全部现成；缺的是"**以整段对话（含助手回答）为输入、可重复触发**"的自动命名。这个缺口**不需要改官方包**，官方给了 4 个可用挂点 |

---

## 0 取证方法与本次新增的只读工具

| 工具 | 位置 | 作用 |
|---|---|---|
| `asar.mjs` | `.recon/asar.mjs`（既有，未修改） | `--list / --print / --grep / --tree / --extract` 读 asar |
| `grepall.mjs` | `.recon/grepall.mjs`（本次新增，只读） | 遍历 asar 头 + 全部文件内容做正则扫描（用于"全构建里有没有 X"） |
| `dbg*.mjs` | `.recon/dbg*.mjs`（本次新增，只读） | 解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 分析标题事件 |

**关键取证难点与解法（供后续复现）**：会话日志是 **zstd 多帧拼接**（一个文件 149 个 frame），`zlib.zstdDecompressSync` 只解第一帧、流式解压会报 `Unknown frame descriptor`。正确做法是按 zstd magic `28 b5 2f fd` 切帧逐帧解压再拼接——`.recon/dbg5.mjs` 是可用实现。**统计口径若用错会得到"0 个会话有标题事件"的错误结论。**

本文用到的本机语料规模：`~/.dsh/sessions` 下 **166** 个 `*.jsonl.zstd`，其中 v4 格式 **155** 个，含 `session/title` 事件的 **150** 个。

---

## 1 官方标题机制到底怎么工作

> 主源：`/dsh/node_modules/@deepseek-ai/dsh-session-title/lib/index.js`（647 行，本次已完整通读）
> 契约文档：`/dsh/node_modules/@deepseek-ai/dsh-session-title/README.zh.md`、`.../dsh-session-title-first-prompt-llm/README.zh.md`、`.../dsh-session-title-llm/README.zh.md`

### 1.1 三个来源，最新者胜

`session/title` 事件的 `source` 是闭合联合（✅源码级，`SessionTitleSource` 类型）：

```ts
export type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'provider'; readonly provider: SessionTitleProviderId; readonly model?: SessionTitleModelIdentity }
  | { readonly kind: 'user' };
```

出处：`/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:6860`（类型目录）；本机事件实测同形。

折叠规则就是"取最后一条"（`dsh-session-title/lib/index.js:188-198`）：

```js
function foldSessionTitle(events) {
  const event = events.findLast((item) => item.type === "session/title");
  if (event === void 0) return void 0;
  return titleSnapshotFromState({ title: event.data.title, messageSeqs: ..., source: ..., eventSeq: event.seq, updatedAt: event.time });
}
```

三个来源的语义差异（**这是需求①最关键的一点**）：

- `fallback`：确定性截断，**同步、必成功**（除非标题清洗后为空）。
- `provider`：LLM 生成，**异步、可失败**。
- `user`：`rename()` 写入，**会"钉住"会话**——`onUserMessage` 首行就检查 `if (this.get(session)?.source.kind === "user") return;`（`lib/index.js:382`），之后**任何自动修订都不会再排程**。唯一的解钉手段是显式 `refresh()`（README 原文："用户来源的最新标题会钉住会话——后续用户消息不再安排自动修订，显式 `refresh()` 仍是有意的解钉手段"）。

### 1.2 什么消息算"合格输入"

`sessionTitleUserMessageOf`（`lib/index.js:89-98`）——**只有**同时满足三个条件的 `user/message` 才算：

```js
function sessionTitleUserMessageOf(event) {
  if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0;
  const text = event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) return void 0;
  return { seq: event.seq, text };
}
```

**✅本机实测**：本机每个会话的真实首条人类消息在 `seq=8`，而紧随其后的 `seq=9/10/11` 是 `source.kind` 为 `runtime-context` / `skill-catalog` / `time-context` 的注入消息——它们**正确地未被当作候选**。实测事件（父会话 `session-eef9c4ef`）：

```
8  user/message  source={"kind":"user","rpcId":"...","clientTimeZone":"Asia/Shanghai"} text="Chat，搜索当前的DSH中的相关插件\n1、通过总结对话..."
9  user/message  source={"kind":"runtime-context","form":"snapshot",...}
10 user/message  source={"kind":"skill-catalog","form":"catalog",...}
11 user/message  source={"kind":"time-context","form":"snapshot",...}
```

### 1.3 确定性回退规则

`fallbackSessionTitle`（`lib/index.js:62-65`）：

```js
function fallbackSessionTitle(input, maxWords, maxBytes) {
  assertPositiveInteger$1("maxWords", maxWords);
  return truncateTitleUtf8(cleanTitleText(input).split(" ").filter(Boolean).slice(0, maxWords).join(" "), maxBytes).trimEnd();
}
```

即：清洗 → **按空格分词取前 `fallbackMaxWords` 个词** → 按 UTF-8 字节截断到 `fallbackMaxBytes`（绝不切断码点）。

**中文场景的隐藏行为（✅本机实测 + 源码确认）**：中文没有空格，`split(" ")` 只得到 1 个"词"，于是 `fallbackMaxWords: 5` 完全不起作用，**实际生效的只有 `fallbackMaxBytes: 40`**。字节级验证：

| 会话 | 回退标题 | 字节数 | 验证 |
|---|---|---|---|
| `session-eef9c4ef`（父） | `Chat，搜索当前的DSH中的相关插` | 4+3+15+3+15 = **40** | 正好卡在 40 字节，"件"被切掉 |
| `980fbce3`（我，子代理） | `你是在为 DSH（DeepSeek Harness）` | 12+1+3+3+8+1+7+3 = **38** | 再加"桌面版"(9B) 就超 40 |

清洗规则（`lib/index.js:10-26`）：剥 OSC/CSI/ESC 终端控制序列、非空白 C0/C1 控制符、方向性与不可见控制符，空白折叠为单个空格。

### 1.4 产生时机 —— 不是"轮次结束"，而是"第一次主请求头之后"

这是最容易搞错的一点。**✅本机实测**的父会话完整时序：

```
 8  user/message         ← 第一条合格人类消息（排程触发点）
 9~11 user/message       ← runtime-context / skill-catalog / time-context（不合格）
12  request/header       ← onRequestHeader 看到 pending.throughSeq(8) < 12 → 启动
13  request/context
14  session/title        ← 回退标题（defer 里的 ensureFallback）
15  session/title-llm-request  ← 提供方真正发起 LLM 调用
16  assistant/message    ← 助手回答（与 LLM 标题请求并发！）
```

对应代码：`onUserMessage` 只做两件事——排程 `state.pending = { registration, revision, throughSeq: event.seq }`（`lib/index.js:386-393`），并 `defer(ensureFallback)`（`lib/index.js:395-402`）。真正启动在 `onRequestHeader`（`lib/index.js:405-415`）：

```js
onRequestHeader(session, event) {
  const pending = state?.pending;
  if (state === void 0 || pending === void 0 || pending.throughSeq >= event.seq) return;
  const route = { provider: event.data.header.config.provider, model: event.data.header.config.model };
  this.startPending(session, state, pending, route);
}
```

**为什么要等 `request/header`**：提供方若未显式配置 `provider`/`model`，需要继承"当前已记录主请求的确切路由"。profile 里 `dsh-session-title-first-prompt-llm` 的 config 只给了 `targetWords/targetCjkCharacters/maxInputBytes/maxOutputTokens/timeoutMs`，**没有给 `provider`/`model`**，所以它必然走"继承路由"路径（`dsh-session-title-llm/lib/index.js:138-146`）：

```js
function resolveRoute(config, request) {
  if (config.provider !== void 0 && config.model !== void 0) return { provider: config.provider, model: config.model };
  if (request.route === void 0) throw new Error("session-title-llm: no logged request route is available; configure provider and model together");
  return request.route;
}
```

**✅本机实测路由确认**：父会话 `session/title-llm-request` 里 `route = {"provider":"opencode-go","model":"deepseek-v4.1-flash"}`，与主请求模型一致。

另有第二条启动路径 `onMainRequest`（挂在 `ctx.on("llm/stream", ..., { global: true, prepend: true })`，`lib/index.js:262-268, 417-430`），用于路由未变、无需等 header 折叠的场景。

### 1.5 只命名一次：first-prompt 的排程闸门

`lib/index.js:379-393`（源码格式化版本见 `lib/types/index.js:350-369`）：

```js
onUserMessage(session, event) {
  if (!this.serviceActive()) return;
  if (event.data.source.kind !== "user" || sessionTitleUserMessageOf(event) === void 0) return;
  if (this.get(session)?.source.kind === "user") return;          // 用户改名 → 钉住
  const registration = this.registration;
  if (registration !== void 0 && !registration.closing) {
    const count = this.titleInputOf(session).count;
    const shouldSchedule =
      registration.provider.automatic === "all-prompts"
      || (session.header.parentSession === void 0 && count === 1 && this.get(session) === void 0);
    if (shouldSchedule) { /* state.pending = { registration, revision, throughSeq: event.seq } */ }
  }
  this.defer(async () => { await this.ensureFallback(session); });
}
```

三个闸门条件（first-prompt 分支）：`session.header.parentSession === undefined`（非子会话）、`count === 1`（只有一条合格消息）、`this.get(session) === undefined`（还没有任何标题）。

**`registration.provider.automatic` 只有两个合法值**（`lib/index.js:596`）：

```js
if (candidate.automatic !== "first-prompt" && candidate.automatic !== "all-prompts") throw new Error("session-title provider automatic mode is invalid");
```

而随本机构建的 `dsh-session-title-first-prompt-llm` 注册的是 **`"first-prompt"`**（`.../lib/index.js:27`）：

```js
registerSessionTitleLlmProvider(ctx, config, name, "first-prompt", (messages) => {
  const first = messages[0];
  if (first === void 0) throw new Error("first-prompt title provider requires one human message");
  return [first];
});
```

→ **本机构建下，LLM 自动命名每个会话至多一次，且只对顶层会话生效。**

### 1.6 失败 / 超时如何回退

链路（`dsh-session-title-llm/lib/index.js:184-248`）：

- 输入超限：`if (inputBytes > config.maxInputBytes) throw new Error("session-title-llm: input is ... exceeding maxInputBytes ...")`（:195）
- 超时：`deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)`，`SESSION_TITLE_TIMEOUT_CODE = "SESSION_TITLE_TIMEOUT"`（:71, :205）
- 输出终止理由：`finishError()` 把 `max-tokens` / `tool-calls` / `error` / `aborted` 全部转成抛错（:161-174）
- 空输出：`if (title.length === 0) throw new Error("session-title-llm: title model produced no text")`（:236）

服务侧（`dsh-session-title/lib/index.js`）：

- 自动路径失败 → **只 warn，不覆盖**：`this.ctx.logger.warn(\`session "${session.id}": automatic title generation failed: ${String(error)}\`)`（:441）
- 被更新的用户消息取代 → `supersede()` 用 `AbortController` 中止旧工作，`assertCurrent()` 拒绝陈旧完成（:517-524, :542-547）
- 结果校验失败 → `validateResult()` 抛错（:481-515），同样只 warn
- 陈旧结果**无法追加**：`runProvider` 在 `session.append("session/title", ...)` 之前先 `this.assertCurrent(session, work)`（:463-473）

**净效果：先落一条 `fallback` 保底，LLM 成功才追加 `provider` 覆盖；失败就永远停在 fallback。**

⚠️ **未证实**：父会话 `session-eef9c4ef` 在 `seq=15` 记录了 `session/title-llm-request`，但到 `seq=291`（会话结束前）**始终没有被接受的 provider 标题**，标题停在 fallback。**失败的具体原因未证实**——本机 `~/.dsh` 下没有任何 `*.log`（只有 `sessions/ storages/ profiles/ attachments/ llm-deepseek/ speech-to-text/ .pideck` 等目录），无法读到那条 warn。

### 1.7 本机实测分布（✅本机实测，150 个含标题事件的 v4 会话 / 共 155 个 v4 会话）

`source.kind` 序列分布（按会话计）：

| 序列 | 会话数 | 含义 |
|---|---|---|
| `fallback → provider:session-title-first-prompt-llm` | **59** | 正常路径：回退保底 + LLM 覆盖 |
| `fallback` | **38** | 只有回退（子会话，或 LLM 失败） |
| `fallback → provider → user` | **37** | 之后被用户手动重命名 |
| `fallback → user` | **11** | LLM 没成功，用户改名 |
| `fallback → provider → user → user` | 3 | 多次改名 |
| `fallback → user → user` | 2 | 多次改名 |
| （无标题事件） | 5 | 无合格人类消息 |

**没有任何一个会话出现两次 `provider` 标题事件** —— 直接证实"LLM 自动命名至多一次"。

计数口径提醒：`session/title-llm-request` 事件共 **124** 条，被接受的 `provider` 标题共 **99** 条（59+37+3）→ 约 **25 次（~20%）LLM 请求没有产出被接受的标题**，全部静默回退。这里的差值可能含继承事件，**精确失败率 ⚠️未证实**，但"存在失败并静默回退"这一事实✅。

**子会话（subagent / fork）行为（✅本机实测）**：

- `origin:"subagent"` 且 `isSeeded:false` 的子会话 → **从不排程 LLM 标题，只有 fallback**。实测本工作区 5 个子会话（`1bf06a07` / `556e108c` / `84d055c5` / `980fbce3` / `ad80f2e0`，全部 `parentSession:"session-eef9c4ef..."`, `isSeeded:false`）的 `reqs=0 prov=0`。
- `isSeeded:true` 的子会话 → 它日志里的 `session/title` / `session/title-llm-request` 是**从父会话继承来的**，不是自己生成的。**✅本机实测对照**：

  | 会话 | seq | 事件 |
  |---|---|---|
  | 父 `session-4f82b62d` | 14 / 15 / 18 | fallback / llm-request / provider `回复OK的简单测试` |
  | 子 `0258cbfb`（`isSeeded:true`） | 14 / 15 / 18 | **完全相同的三条** |

  机制依据：`dsh-session/lib/index.js:1271-1273` 注释 —— *"Seed events never publish on `session/event`"*，所以继承事件不会触发 `onUserMessage`；且该子会话在 `seq=22` 有 `session/end-seed {inherited:true}` 标记继承边界。这与 README 一致："fork 会保留继承的标题，绝不会自动运行此提供方。"（`dsh-session-title-first-prompt-llm/README.zh.md:32`）

---

## 2 输入到底是什么

### 2.1 服务交给 provider 的 `messages`：只有人类消息

`runProvider`（`dsh-session-title/lib/index.js:456`）：

```js
const messages = collectSessionTitleMessages(session.snapshotEvents(), work.throughSeq);
const result = await work.registration.provider.generate({ session, messages, ...route === void 0 ? {} : { route }, signal: work.signal });
```

`collectSessionTitleMessages`（:161-169）逐条调用 `sessionTitleUserMessageOf`，即**只收集合格人类消息**。

类型确认（`dsh-tool-cordis/lib/types/api-catalog.js:6847-6864`）：

```ts
export interface SessionTitleProviderRequest {
  readonly session: Session;
  readonly messages: readonly SessionTitleUserMessage[];
  readonly route?: SessionTitleModelIdentity;
  readonly signal: AbortSignal;
}
export interface SessionTitleUserMessage { readonly seq: SessionSeq; readonly text: string; }
```

**→ 通过 `messages` 只能拿到人类的 prompt，拿不到助手回答、工具调用与结果。**

### 2.2 但是 provider 拿到了整个 `Session` —— 可以自己读全量日志

`request.session` 是一个完整 `Session` 对象。`dsh-session-title` 自己的实现就是这么干的：

```js
const messages = collectSessionTitleMessages(session.snapshotEvents(), work.throughSeq);
```

（`lib/index.js:456`）—— `session.snapshotEvents()` 返回**全量日志事件**，包含 `assistant/message` / `tool/call` / `tool/result`。

**→ 结论：官方在"输入通道"上确实只给人类消息，但**没有封闭**读取助手内容的可能。自定义 provider 完全可以用 `request.session.snapshotEvents()` 自行拼出"整段对话"。**这是需求①最重要的可用缝隙。**

### 2.3 有没有"多轮后重新命名 / 刷新标题"的路径

按可操作性从低到高排列：

**(a) 官方的 `all-prompts` 节奏 —— 服务支持，但本机构建没有实现它的插件。**

服务源码里明确支持（`lib/index.js:386, 596`），文档也把它列为"随附的两个提供方"之一（`dsh-session-title/README.zh.md:57, 109`），包说明在官方技能参考里被列为可用：

```
| `@deepseek-ai/dsh-session-title-all-prompts-llm` | yes | All-user-messages LLM provider plugin for DeepSeek Harness session titles |
```
（`/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:362`）

但 **✅本机实测：该包不在本机构建里**。全 asar 正则 `all-prompts` 的命中只有：3 个包的 README 交叉引用、`dsh-session-title` 自身的两处代码、`dsh-session-title-llm` 的一处、`dsh-tool-cordis` 的类型声明、`packages.md` 一行 —— **没有任何实现代码**。

**(b) `refresh(session, signal?)` —— 唯一的显式重算入口。**

`dsh-session-title/lib/index.js:319-350`。行为：有注册提供方 → 用**当前提供方**显式重跑；无提供方 → 物化回退；若当前标题是 `user` 来源则先写回退（解钉）。

**关键限制：它用的是同一个注册提供方，无法换输入口径。** first-prompt 提供方的 `selectMessages` 永远是 `messages[0]`，所以 `refresh()` 对 first-prompt 而言只是"重试首条消息的标题"。

**(c) 客户端没有任何触发 `refresh` 的入口。** ✅本机实测：全 asar 正则 `sessionTitle.refresh` / `titles.refresh` **0 命中**（唯一的 `ctx.sessionTitle.*` 外部调用是 `dsh-webhook/lib/index.js:183` 的 `rename`）。

**(d) 注册自己的提供方 —— 但同一时刻只能有一个。**

```js
register(provider) {
  this.validateProvider(provider);
  if (this.registration !== void 0) throw new Error(`session-title provider "${this.registration.provider.id}" is already registered`);
  ...
}
```
（`lib/index.js:357-359`）

README 把这条限制写死了（`dsh-session-title/README.zh.md:139`）：*"至多一个提供方——注册表有意只接受一个实现，因此部署若要组合相互竞争的标题策略，必须编写一个自行负责优先级的提供方。"*

**→ 要用 `all-prompts` 节奏，必须先卸载/禁用 profile 里的 `dsh-session-title-first-prompt-llm`（或写一个自带优先级逻辑的统一提供方）。**

### 2.4 `all-prompts` 的时机也有个坑

`onUserMessage` 里 `throughSeq: event.seq` = **最新那条用户消息的 seq**，而启动要等该轮的 `request/header`。所以 `all-prompts` 的重算**发生在该轮助手回答之前**：

- 能看到：**之前所有轮次**的完整对话（含助手回答与工具结果）
- 看不到：**当前这一轮**的助手回答

**→ 若目标是"每轮结束后用完整对话（含本轮回答）重新命名"，`all-prompts` 节奏本身也不够，需要自己挂在 `turn/end` 上。**

---

## 3 标题如何落库

### 3.1 事件名（✅源码级）

| 事件 | 写入者 | 备注 |
|---|---|---|
| `session/title` | 服务（fallback / provider 接受 / rename） | **持久化的标题真源** |
| `session/title-llm-request` | `dsh-session-title-llm` | LLM 调用审计记录 |

两者都在官方"已知事件类型"白名单里（`/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js:53-56`）：

```js
'session-log-deepseek/delivery-accepted',
'session/end-seed',
'session/title',
'session/title-llm-request',
```

**注意类型强度差异（✅源码级）**：只有 `session/title` 进了 `SessionEventMap`（即被官方类型系统认领），`session/title-llm-request` **只在白名单里、不在 `SessionEventMap` 里**——它靠 `SessionEventMap` 的"merge-extensible"机制由插件自行声明，实际上没有类型签名。所以外部插件**不要**依赖它的字段结构。

`SessionEventMap` 成员（`dsh-api-session-controller/lib/typert.host.js`）：
```ts
'session/title': SessionTitleEventData;
```

### 3.2 字段（✅源码级）

```ts
export interface SessionTitleEventData {
  readonly title: string;
  readonly messageSeqs: SessionSeq[];
  readonly source: SessionTitleSource;
}
```
（`dsh-tool-cordis/lib/types/api-catalog.js:6827`）

**✅本机实测的原始事件行**（`~/.dsh/sessions/--<branch-repo-slug>--/session-4f82b62d-.../session.v4.jsonl.zstd`）：

```json
{"seq":14,"type":"session/title","time":...,"data":{"title":"只回复两个字母：OK","messageSeqs":[8],"source":{"kind":"fallback"}}}
{"seq":15,"type":"session/title-llm-request","time":...,"data":{"titleProvider":"session-title-first-prompt-llm","messageSeqs":[8],"route":{"provider":"deepseek-official","model":"deepseek-flash"},"system":"Create a concise title for an AI coding-assistant session from the supplied human messages.\n...","messages":[...],"maxTokens":64}}
{"seq":18,"type":"session/title","time":...,"data":{"title":"回复OK的简单测试","messageSeqs":[8],"source":{"kind":"provider","provider":"session-title-first-prompt-llm","model":{"provider":"deepseek-official","model":"deepseek-flash"}}}}
```

`session/title-llm-request` 的写入代码（`dsh-session-title-llm/lib/index.js:216-223`）：

```js
request.session.append("session/title-llm-request", {
  titleProvider, messageSeqs: selectedMessages.map((message) => message.seq), route, system, messages, maxTokens: config.maxOutputTokens
});
```

### 3.3 投影单元（✅源码级）

服务注册两个单元（`dsh-session-title/lib/index.js:235-250`）：

```js
ctx.sessionProjections.register(titleProjectionDefinition);
ctx.sessionProjections.register({
  key: "titleInput",
  stateVersion: 3,
  stateSchema: titleInputStateSchema,
  init: () => EMPTY_TITLE_INPUT,
  apply: (state, event) => { ... first / count / lastSeq ... }
});
```

`title` 单元（`lib/index.js:170-182`）——**客户端可见**：

```js
const titleViewSchema = z$1.string().min(1).nullable();
const titleProjectionDefinition = {
  key: "title",
  stateVersion: 1,
  stateSchema: titleViewSchema,
  init: () => null,
  apply: (state, event) => event.type === "session/title" ? event.data.title : state,
  wire: { viewSchema: titleViewSchema, view: (state) => state }
};
```

`titleInput` 单元（`lib/index.js:131-151, 236-250`）——**host 专用，没有 `wire`**，只保留 `{ first: {seq,text} | null, count, lastSeq }`。全部合格消息的完整前缀在需要时才从日志扫描（`collectSessionTitleMessages` 的注释说明了这是刻意的 O(1) 设计）。

投影注册/读取 API（`dsh-session-projection/lib/index.js`）：`register(def)` :68、`onChanged(listener)` :110、`stateOf(session, key)` :127、`snapshot(session, keys)` :142、`cachedSnapshot` :165、`checkpoint` :196、`restore` :287。驱动在 `drive()`（:402-428）：每个 committed event 走每个单元，仅当 `wire` 视图按 `Object.is` 变化才通知。

### 3.4 持久化（✅本机实测）

**(a) 会话日志**：`$env:DSH_HOME\sessions\<projectKey>\<sessionId>\session.v4.jsonl.zstd`

- 第 1 行是会话头（`{"type":"session","version":4,"id":...,"cwd":...,"parentSession"?,"isSeeded","origin"?,"delegationDepth","agentPreset"?}`），后续是事件行。
- zstd **多帧**压缩（149 帧/文件量级）。
- 配置来源：profile `session-persistence-jsonl`，`root: dshHomePath('sessions')`。

**(b) 投影缓存**：`$env:DSH_HOME\storages\session_projcache\sessions\<sessionId>.json`

**✅本机实测**（本次会话 `980fbce3`）的原始结构：

```json
{"version":7,"record":{
  "identity":{"formatVersion":4,"createdAt":1790915531643,"cwd":"<repo>","isSeeded":false,"inheritedEventCount":0},
  "rows":{
    "title":{"ver":1,"seq":126,"val":"你是在为 DSH（DeepSeek Harness）"},
    "titleInput":{"ver":3,"seq":126,"val":{"first":{"seq":8,"text":"..."},"count":1,"lastSeq":8}},
    "turnOutline":{"ver":2,"seq":126,"val":{"turns":[...],"draft":"..."}},
    "sessionStats":{"ver":1,"seq":126,"val":{"turns":1,"steps":18,...}},
    ...
  }}}
```

行结构 `key → {ver, seq, val}`，来自 `dsh-session-projection-cache/lib/index.js:11, 57-64`（`rows: z.record(z.string(), checkpointRow)`）。写入节流：profile 配置 `writeEveryEvents: 200 / writeIntervalMs: 5000`。

### 3.5 服务接口（✅源码级，权威目录）

`@deepseek-ai/dsh-session-title` 注册的服务名是 `sessionTitle`，API 面（`dsh-tool-cordis/lib/types/api-catalog.js:2393-2423`）：

| 签名 | 说明 |
|---|---|
| `get(session: Session): SessionTitleSnapshot \| undefined` | 读最新折叠标题（live 或 replay） |
| `rename(session: Session, title: string): SessionTitleSnapshot` | 写 `user` 来源，**钉住**；标题清洗后为空则抛 `SessionTitleInvalidError` |
| `async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot \| undefined>` | 显式重跑注册提供方 / 物化回退 |
| `register(provider: SessionTitleProvider): () => Promise<void>` | 注册唯一提供方；再次注册抛错 |

提供方契约（`api-catalog.js:6823-6852`）：

```ts
export type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts';
export interface SessionTitleProvider {
  readonly id: SessionTitleProviderId;
  readonly automatic: SessionTitleAutomaticMode;
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>;
}
export interface SessionTitleProviderResult {
  readonly title: string;
  readonly messageSeqs: readonly SessionSeq[];
  readonly model?: SessionTitleModelIdentity;
}
```

### 3.6 从外部改标题：官方挂点与硬约束

**挂点 A：`ctx.sessionTitle.rename(session, title)`** —— 最简单，但产生 `{kind:'user'}`，**永久钉住**该会话（后续不再自动修订），且要求会话 live（`lib/index.js:297`：`if (this.ctx.sessions.get(session.id) !== session) throw ...`）。
已有先例：`dsh-webhook/lib/index.js:183` 在创建一个 Session 后调用 `ctx.sessionTitle.rename(handle.agent.session, resolved.title)`。

**挂点 B：`ctx.sessionTitle.register({ id, automatic: 'all-prompts', generate })`** —— 唯一能进入官方调度循环的方式。**必须先腾出位置**（`registration !== undefined` 时抛错），即禁用 profile 里的 `dsh-session-title-first-prompt-llm`。

**挂点 C：直接 `session.append("session/title", {title, messageSeqs, source:{kind:'provider', provider:'<自定 id>', model?}})`** —— 绕过提供方注册表，完全自主控制触发时机（例如挂在 `turn/end`）。
**✅源码级约束**：包自带不变量会校验**任何写入者**（`dsh-session-title/lib/invariant.js:20-39`）：

```js
if (messageSeqs.length === 0 !== (source.kind === "user")) fail(`... must ${requirement} ...`);
...
if (cited?.type !== "user/message" || cited.data.source.kind !== "user")
  fail(`session/title event ${event.seq} message seq ${checked} must name an earlier human user/message`);
```

→ 非 `user` 来源的 `session/title` **必须**：`messageSeqs` 非空、去重、每一个都指向**更早的、`source.kind === "user"`** 的 `user/message`。校验挂在 `ctx.on("internal/dispatch", ...)` 上（:46-50），是全局的。

**挂点 D：走 RPC `session.rename`**（等价于 A，见 §4）。

**触发器挂点（✅源码级）**：

- `ctx.on("session/event", (session, event) => ...)` —— `dsh-session-title` 自己就用这个（`lib/index.js:251-261`）。事件在 `dsh-session/lib/index.js:1460-1473` 发射，参数是 `(session, event)`。
- `ctx.on("session/created" | "session/disposed", ...)`。
- `ctx.on("llm/stream", (options, next) => ..., { global: true, prepend: true })`。
- 注意：`session/event` 分派只对**非 seed 事件**发生（`dsh-session/lib/index.js:1273` 注释 + `1466-1473` 的 `entry !== undefined` 门），所以"继承/fork 进来的历史"不会触发。
- `session.snapshotEvents()` 取全量日志；`session.requestHeader()?.config` 取当前路由。

---

## 4 客户端侧重命名入口

### 4.1 用户可用的三个入口（✅源码级）

实现全在 **`@deepseek-ai/dsh-client-ui-workspace`**（不在 `dsh-client-ui-sidebar`，也不在 `dsh-client-ui-session`）：

| 入口 | 代码位置 |
|---|---|
| 会话行「⋯」菜单 → **重命名**（`sidebar.workspaces.session.menu.item`, `id:"rename"`, `order:200`） | `dsh-client-ui-workspace/lib/client.js:4339-4345`，组件 `RenameSessionMenuItem` :3685-3696 |
| **双击标题** | `client.js:1630`：`onRenameRequest(node.id, row.title)`；`SessionNodeItem` 的 `onRenameRequest` 形参说明见 :1562 |
| **快捷键** `session.rename`（默认 `KeyG` + Primary/Alt 组合） | `client.js:160`：`register("session.rename", () => t("rename.session.title"), ["rename session"], "KeyG", ["primary","alt"], ["primary","alt"], ...)`，:168 `controls.rename(target.id, target.title?.trim() ?? "")` |

弹窗在 `shell.overlay` 里（`id:"workspace.session-rename"`，:4380-4383），组件 `SessionRenameDialog` :3706-3715 / `RenameForm` :3717-3785。与工作区重命名不同，**会话重命名没有客户端重名冲突规则**（:3702 注释），空标题由 host 拒绝。

### 4.2 完整调用链（✅源码级）

```
UI RenameForm
  → renameSession(sessionId, title)                       client.js:4176-4177
  → sessions.using(sessionId, {source:"workspaceOperation"}, ref => ref.binding.session.rename(title))
  → [客户端 Session] this.remote.session.rename({sessionId, title})   api-session-controller/lib/types/client/sessions/session.js:277-284
  → [RPC] '@deepseek-ai/dsh-api-session-controller#session/rename'   .../lib/typert.host.js:1256-1278
  → [Host] SessionCommands.rename(request)                .../lib/types/commands.js:182-198
  → ctx.get('sessionTitle')  (未挂载 → RemoteError 'gateway/internal')
  → titles.rename(agent.session, request.title)           → session/title {source:{kind:'user'}}
  ← { title: accepted.title, seq: accepted.eventSeq }
  → [客户端] this.projections.apply('title', value.title, SessionSeq(value.seq))   session.js:282
```

契约 schema（`.../lib/typert.host.js:807-815`）：

```js
// SessionRenameRequest
z.object({ 'sessionId': ..., 'title': z.string().readonly() })
// SessionRenameValue
z.object({ 'title': z.string().readonly(), 'seq': z.number().readonly() })
```

错误码：`session/title-invalid`（标题清洗后为空）/ `gateway/internal`（未挂载标题服务或其它失败）——见 `commands.js:186, 194, 196` 与 `RemoteErrorDetailsMap` 里的 `'session/title-invalid': { readonly sessionId: SessionId; }`。

### 4.3 标题怎么到达客户端

**没有专用的标题帧**——列表行直接读通用投影键（`.../lib/types/client/sessions/manager.js:670-686`）：

```js
buildListSnapshot() {
  const merged = this.summaries.map((summary) => {
    // List rows read the generic 'title' projection key (host-computed unit
    // value; there is no dedicated title frame).
    const projectionStore = this.projectionStores.get(summary.sessionId);
    const title = projectionStore?.get('title');
    ...
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
```

侧栏渲染（`dsh-client-ui-workspace/lib/client.js:391-393`）：

```js
function sessionTitle(session) {
  return session.blank ? "" : session.title?.trim() ?? "";
}
```

**✅本机实测的客户端读者范围**：全 asar 搜索 `sessionTitle` 只命中 3 处类型/契约 + `dsh-client-ui-workspace` 的 4 处（:391, :457, :579, :602）。`dsh-client-ui-chat` / `dsh-client-ui-conversation` / `dsh-client-ui-session` 中 **没有任何 `title` 投影读取者**（chat 读 `turnOutline`/`inbox`/`tokenUsage`/`sessionStats`；conversation 读 `modelSelection`/`plan`/`goal`/`inbox`/`contextPressure`/`contextBreakdown`/`imageLimits`）。

**→ 标题只出现在侧栏/工作区会话列表行。** `dsh-client-ui-sidebar` 只提供 `sidebar.workspaces` 挂点，渲染实际由 `dsh-client-ui-workspace` 负责。

### 4.4 客户端**没有**"AI 重新生成标题"的入口

✅本机实测：全 asar `sessionTitle.refresh` / `titles.refresh` 0 命中。`refresh()` 目前**没有任何官方调用方**——它是一个纯粹面向插件/部署的 API。

---

## 5 邻近插件的"总结"能力，可否复用来命名

| 插件 | 产物 | 存在哪 | 能否用于命名 |
|---|---|---|---|
| `dsh-session-turn-outline` | 每轮的 prompt 预览（≤50 字符）+ 最终助手回答预览（≤120 字符）+ `draft` | 投影 `turnOutline`（有 wire，客户端可见），**不是事件** | ⚠️ 只能当"话题线索"，**纯截断、无总结**，且每轮只有一条助手回答的前 120 字符 |
| `dsh-session-stats` | `turns/steps/llmMs/toolMs/ttftMs/decodeMs/decodeTokens` | 投影 `sessionStats` | ❌ 纯数字，**无任何文本** |
| `dsh-compaction-basic` | `compaction/summary` 的 `summary`（**真实的整段对话摘要**） | **事件**，持久化在日志；同时追加一条替换用的 `user/message` | ✅ **最有价值的可复用产物**，但有触发条件限制 |
| `dsh-session-log-deepseek` | `dsh_session_log` 请求字段（原始日志前段上传到官方 API） | 不是会话内产物 | ❌ 与"总结"无关，只是上传 |

### 5.1 `dsh-session-turn-outline` —— 无 LLM，纯确定性截断

`dsh-session-turn-outline/lib/index.js:24-27`：

```js
/** Prompt budget: one rail-card line (13px over ~276px), ASCII worst case included. */
const PROMPT_PREVIEW_LIMIT = 50;
/** Response budget: three rail-card lines (12px over ~276px). */
const RESPONSE_PREVIEW_LIMIT = 120;
```

`apply`（:82-136）以 `turn/start` 为锚，`user/message`（`source.kind==='user'`）填 `prompt`，`assistant/message` 写 `draft`，`turn/end` 把 `draft` 提交为 `response`。**✅本机实测**（本会话 projcache）：`"turnOutline":{"ver":2,...,"val":{"turns":[...],"draft":"Now let me extract the related packages for batch searching."}}`。

**→ 无 LLM 调用、无总结语义、每轮只保留首 120 字符。可作轻量线索，不能当命名输入。**

### 5.2 `dsh-session-stats` —— 只有数字

`dsh-session-stats/lib/index.js:28-37` 的 schema 全是 number。**→ 与命名无关。**

### 5.3 `dsh-compaction-basic` —— **真正的整段对话摘要，最有复用价值**

**✅本机实测：`compaction-basic` 在真实会话里是活跃的**——155 个 v4 日志中 `compaction/start` 174 条、`compaction/summary` 174 条。（注意：`cordis.yml` 顶层把它标了 `disabled: true`，但它在 `preset-standard` 的 `compaction` 组里是启用的，而会话头的 `agentPreset` 就是 `"standard"`。）

写入代码（`dsh-compaction-basic/lib/index.js:634-649`）：

```js
const summaryEvent = session.append("compaction/summary", {
  compactionId: startEvent.data.compactionId,
  ...startEvent.data.sourceCommandId === void 0 ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
  summary,
  ...callRecord,
  shadowedRange: { start, end },
  shadowedSeqs: [...shadowedSeqs],
  shadowedTokenCount,
  provider, model,
  ...maxTokens === void 0 ? {} : { maxTokens },
  ...usage === void 0 ? {} : { usage }
});
session.append("user/message", checkpointMessage, {
  surfaceOp: { op: "replace", startSeq: start, endSeq: end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
});
```

**✅本机实测的真实摘要内容**（`af10ed09` 会话 `seq=1324`，共 10,371 字符，`shadowedRange {start:10,end:944}`，`shadowedTokenCount 234892`，`model deepseek-v4.1-flash`）：

```
## Primary Request and Intent
- Initial: 「读取当前的项目内容」 — read and report the project state.
- Then: 「请先修正文档漂移」 — fix the 4 doc-drift items the agent had reported ...
- Then: 「下一步应该做什么?」 — asked for a prioritized next step; ...
## Key Technical Concepts
- Project: `dsh-plugin-branch` v0.2.0 ...
...
```

`summary` 的类型是**内容块数组**（`[{type:'text', text:'## Primary Request and Intent\n...'}]`），不是裸字符串——**提取时必须 `filter(b => b.type === 'text').map(b => b.text).join('\n')`**。

**用于命名的可行性（✅/⚠️）**：

- ✅ **语义质量最高**：这就是"整段对话讲了什么"的结构化摘要，`## Primary Request and Intent` 一节甚至直接把用户诉求按顺序列了出来。
- ✅ 已经在日志里，不需要额外 LLM 调用就能拿来生成标题。
- ⚠️ **覆盖不完整**：只在压缩触发时才存在。实测分布极端——`af10ed09` 有 1 条摘要覆盖 `seq 10→944`；而很多会话（包括本会话 `980fbce3`）**完全没有** `compaction/summary`。
- ⚠️ 它是"为压缩而写的摘要"，长度上万字符，**不是标题**，仍需二次提炼（可以用纯规则取 `## Primary Request and Intent` 的首条，或再发一次小 LLM 调用）。
- ⚠️ 它替换了会话表面（`surfaceOp: replace`），读取时要注意 `shadowedSeqs` 语义。

### 5.4 `dsh-session-log-deepseek` —— 与总结无关

`dsh-session-log-deepseek/lib/index.js:137-189` 注册的是一个 DeepSeek API 请求字段扩展，把**未确认的原始日志前缀**塞进 `dsh_session_log` 请求字段上传，并追加 `session-log-deepseek/delivery-accepted` 作为水位。**→ 它是遥测上传通道，不产生任何摘要。**

---

## 6 缺口判定

### 6.1 需求①（总结整段对话后自动命名）的覆盖度

| 子能力 | 官方现状 | 判定 |
|---|---|---|
| "会话有一个自动派生的标题"这个**机制** | `session/title` 事件 + `title` 投影 + 三源折叠 + 客户端渲染 | **已覆盖** |
| 从**第一条人类消息**派生标题 | `first-prompt` 提供方（LLM）+ 确定性回退 | **已覆盖** |
| 从**整段对话**（含助手回答）派生标题 | 官方只把人类消息交给提供方；`all-prompts` 节奏在本机构建**无实现** | **完全缺失** |
| **多轮后重新命名**（可重复触发） | 服务支持 `all-prompts` 节奏，但无插件；`refresh()` 无任何调用方，且换不了输入口径 | **完全缺失** |
| 自动命名在**每轮结束后**触发 | 时机是"用户消息之后的第一个 `request/header`"，**永远早于当前轮的助手回答** | **部分覆盖（时机不对）** |
| 标题**落库/持久化/客户端呈现** | 事件 + 投影 + projcache + 侧栏行 | **已覆盖** |
| 用户**手动**重命名 | 菜单 / 双击 / 快捷键 / RPC / 钉住语义 | **已覆盖** |
| 外部插件**自己写标题** | 4 个挂点（rename / register / 直 append / RPC）+ 明确的不变量约束 | **已覆盖** |
| 复用**现成的对话摘要** | `compaction/summary` 是真实摘要但不是标题、且不总存在 | **部分覆盖** |

### 6.2 **判定：部分覆盖**

官方把"标题"这件事的**管道**修得非常完整——事件、投影、持久化、客户端、重命名 API、不变量、并发与取代语义、失败回退，全都现成。**唯一缺的是一段"用整段对话做输入、可以反复跑"的生成逻辑。**

缺的**不是**机制，而是三个具体的东西：

1. **输入口径缺口**：官方调度器只挑人类消息（`sessionTitleUserMessageOf`），助手回答与工具结果从不进入 `request.messages`。
2. **触发时机缺口**：唯一的自动触发点是"用户消息 + 首个 `request/header`"，因此**当前轮的助手回答必然缺席**；`turn/end` 上没有任何官方自动钩子。
3. **节奏实现缺口**：`all-prompts` 节奏在服务里实现了，但**本机构建没有实现它的插件包**（`@deepseek-ai/dsh-session-title-all-prompts-llm` 不在 asar 内）。

### 6.3 可挂的扩展点（按侵入性从低到高）

| # | 做法 | 侵入性 | 关键约束 |
|---|---|---|---|
| A | `ctx.on("session/event")` 捕获 `turn/end` → 自调 `ctx.llm.stream` 总结整段对话 → `ctx.sessionTitle.rename(session, title)` | **最低**，不改 profile，可与其他插件共存 | 产出 `source.kind:'user'` → **永久钉住**；`rename` 要求会话 live；与内置 first-prompt 存在竞争（我们的写入会被后到的 provider 事件覆盖，需自行处理次序） |
| B | 同上，但改为 `session.append("session/title", {title, messageSeqs, source:{kind:'provider', provider:'<self id>'}})` | 低 | 必须满足不变量：`messageSeqs` 非空、去重、每条都指向**更早的**`source.kind==='user'` 的 `user/message`（`dsh-session-title/lib/invariant.js:20-39`）。**不钉住**，后续仍可自动修订 |
| C | 实现一个 `automatic:"all-prompts"` 的 provider 并 `ctx.sessionTitle.register(...)` | 中 | **必须先腾出注册位**（禁用/卸载 profile 里的 `dsh-session-title-first-prompt-llm`），否则 `register` 抛错（`lib/index.js:359`）。provider 内可通过 `request.session.snapshotEvents()` 读到助手内容，但 `result.messageSeqs` 仍必须取自 `request.messages`（`validateResult` :487-498 只接受请求内的 seq） |
| D | 复用 `compaction/summary` 作为输入，做纯规则提炼或二次小调用 | 低（可与 A/B/C 叠加） | 只在压缩过的会话里存在；`summary` 是内容块数组；需处理其 `surfaceOp: replace` 语义 |

**对 C 的一个额外提醒（✅源码级）**：`validateResult` 的 `messageSeqs` 校验用的是 `order = new Map(messages.map(m => [m.seq, index]))`（`lib/index.js:489-498`），`messages` 就是 `collectSessionTitleMessages(...)` 的结果（**只有人类消息**）。所以即使 provider 读了整段对话来生成标题，**回报的 `messageSeqs` 也只能是那些人类消息的 seq**。这不影响能力，但写实现时容易踩。

### 6.4 一句话设计建议

> 官方已经把"标题事件 / 投影 / 客户端 / 重命名 / 不变量"全部铺好，**不要重造这些**。缺的只是"`turn/end` → 读全量 `session.snapshotEvents()` → 一次小 LLM 调用 → `session.append('session/title', ...)`"这一段约一两百行的生成逻辑；用挂点 B（`source.kind:'provider'`）而不是 `rename()`，可以既拿到整段对话，又保留会话不被永久钉住。

### 6.5 与 lead 已有结论的对齐与两处修正

`docs/recon/README.md` 中"需求①"一节的判断（生态已红海、官方只有首条消息命名、`all-prompts` 上游有本地没装）**与本次勘察一致**。补充/修正两点：

1. **修正措辞**：README 说"今天并没有'总结'发生"。更精确的说法是——**LLM 标题请求确实发出过**（父会话 `seq=15` 有 `session/title-llm-request`，路由 `opencode-go/deepseek-v4.1-flash`），只是**没有被接受的 provider 标题**，所以最终显示的是 40 字节截断的回退。原因未证实（本机无日志文件）。
2. **补充两条可复用事实**：(a) **子会话（`origin:'subagent'`, `isSeeded:false`）从不排程 LLM 标题**，只有回退——所以"给子代理会话命名"是官方完全未覆盖的一块；(b) **`compaction/summary` 是一份真实的整段对话摘要**（含 `## Primary Request and Intent`），是现成可复用的命名素材，但只在压缩过的会话里存在。

---

## 附：本报告引用到的关键文件清单

| asar 内路径 | 用途 |
|---|---|
| `/dsh/node_modules/@deepseek-ai/dsh-session-title/lib/index.js` | 标题服务主实现（647 行） |
| `/dsh/node_modules/@deepseek-ai/dsh-session-title/lib/invariant.js` | `session/title` 写入不变量 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-title/README.zh.md` | 权威契约 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js` | 共享 LLM 生成策略（提示词、封帧、超时、校验） |
| `/dsh/node_modules/@deepseek-ai/dsh-session-title-first-prompt-llm/lib/index.js` + `README.zh.md` | 本机实际装载的提供方 |
| `/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` | `session/event` 发射、seed 不发布、header 构造 |
| `/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js` | 已知事件白名单 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js` | 投影注册表与读写面 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-projection-cache/lib/index.js` | `key → {ver,seq,val}` 持久化 |
| `/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js` + `lib/types/client/sessions/*.js` + `lib/typert.host.js` | 重命名 RPC 全链路 |
| `/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` | 重命名 UI 三入口 + 列表行标题渲染 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-turn-outline/lib/index.js` | 轮次大纲投影 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-stats/lib/index.js` | 会话统计投影 |
| `/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` | `compaction/summary` 写入 |
| `/dsh/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js` | 日志上传扩展 |
| `/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` | 权威类型/服务 API 目录 |
| `/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md` | 官方包清单（`all-prompts` 的"上游有"证据） |
| `/dsh/node_modules/@deepseek-ai/dsh-webhook/lib/index.js` | 外部调用 `ctx.sessionTitle.rename` 的先例 |
