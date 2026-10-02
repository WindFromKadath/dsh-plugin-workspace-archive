# 02 · 需求②：工作区文件夹消失 → 自动归档 / 回来 → 自动恢复

> **环境锚点（已核实）**
> - DSH 桌面版 **0.2.0-rc.2**（`dsh/package.json` → `{"name":"@deepseek-ai/dsh-desktop-runtime","version":"0.2.0-rc.2"}`），官方源码在 `<app>\resources\app.asar`，asar 内根 `dsh/`，官方包位于 `dsh/node_modules/@deepseek-ai/*`。
> - 本机 profile：`$env:DSH_HOME\profiles\desktop\cordis.yml`（`session-persistence-jsonl` → `root: dshHomePath('sessions')`；`storage-json` → `root: dshHomePath('storages')`；`storage-domain` → `backend: json`）。
> - 只读工具：`node plugin-2\.recon\asar.mjs --list|--print|--grep|--tree|--extract <asar> <asar内路径> [extra]`。
> - 本报告引用的行号来自 `.recon\extract\<包名>\lib\index.js`（内容与 asar 内一致）；**权威路径是 asar 内路径**，行号仅供定位。
> - 本轮**未修改** `.dsh`、`plugin-1`、`app.asar`；未创建/删除任何工作区文件夹；写入仅落在 `plugin-2\docs\recon\` 与 `plugin-2\.recon\`。

---

## 结论先行

| 判断项 | 结论 |
|---|---|
| 需求②在官方现有能力里 | **部分覆盖** |
| "归档"这个概念 | **已是一等公民**：存储字段 + Host API + Remote RPC + 客户端服务 + 菜单/快捷键/三态滤镜，全部现成 |
| "工作区文件夹是否还在"这个探测 | **官方已有原语**：`WorkspaceEntity.status()` → `'ok' \| 'missing-dir'` |
| **自动触发**（消失→归档） | **完全缺失**。全 asar 扫描证实 `archiveSession` 的调用方**只有 UI 显式操作**，没有任何自动逻辑 |
| **自动恢复**（回来→恢复） | **完全缺失**。同理，`unarchiveSession` 只有 UI 显式操作 |
| **`status()` 的调用方** | **零**。全 asar 11,470 个文本文件里 `'missing-dir'` 只出现在 2 处定义（+1 处 API catalog 声明），**没有任何消费者**——这是本次勘察最关键的"缺失"证据 |
| 文件夹消失后官方**现存**行为 | 该工作区的会话被**读时过滤**掉（文件留在磁盘、注册表不动、不归档），UI 上掉进"未分组"；只在**下次刷新/重启**才反映出来 |
| 所以缺口是什么 | 缺一个**策略插件**：轮询 `status()` → 对 `missing-dir` 的工作区批量 `archiveSession` → 目录回来后批量 `unarchiveSession`。**零件全在，缺的是胶水 + 一个"哪些是我归档的"的来源标记** |

**一句话**：官方把"归档"和"检测文件夹不在"两块积木都造好了，但**从来没把它们连起来**，而且连接所需的一个关键信息（"这次归档是谁发起的"）官方没有提供——这是本需求最大的设计难点。

---

## 1. 绑定关系：会话属于哪个工作区？

**结论：不靠目录名判定，靠会话文件首行 header 里的 `cwd` 字段，经 `fs.realpath` 规范化后与 workspace record 的 `path` 做字符串相等比较。目录名只是"人类可导航"的副产品。**

### 1.1 两个"绑定"同时存在，但只有一个是权威

| | 载体 | 是否权威 | 是否可逆 |
|---|---|---|---|
| (a) 磁盘目录名 | `<sessions-root>/--<normalized-cwd>--/<encoded-id>/` | ❌ 仅导航用 | ❌ 注释明说 intentionally lossy |
| (b) 会话首行 header | `session.vN.jsonl.zstd` 的第一个 zstd 帧 | ✅ **权威真值** | ✅ 完整保留原始 cwd |

出处：`dsh-session-persistence-jsonl/README.md:56,72`
> "Each session gets a session-owned directory under a readable **project directory**… **Session ids are injectively escaped to one safe path segment** before use… The **normalized cwd keeps the project directory readable for navigation**; cwd strings that normalize alike share a project directory while session ids still select distinct session directories."

### 1.2 文件名规则与 slug 生成算法出处

**布局**（`README.md:58-70`，与原文件系统完全一致）：

```text
<sessions-root>/
  --<normalized-cwd>--/          # 可读的项目目录（无 cwd → _no-cwd/）
    <encoded-id>/                # 会话自有目录
      session.jsonl.zstd         # v0（压缩）
      session.v1.jsonl.zstd
      session.v2.jsonl.zstd
      session.v3.jsonl.zstd
      session.v4.jsonl.zstd      # ← 本机实际使用（当前版本）
      session.jsonl              # v0（未压缩，compression:'none'）
      ... session.vN.jsonl
```

**slug 生成算法**——`dsh-session-persistence-jsonl/lib/index.js:875-894`，函数 `projectKey(cwd)`：

```js
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";        // ← / \ : 折叠成一个 -
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;                            // ← 安全字符原样
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");  // ← 其余 → ~XXXX
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
```

配套：`projectDir(root, cwd)`（`:902-905`，`cwd === undefined` → `join(root,'_no-cwd')`）、`sessionDir(root, cwd, id)`（`:914-916`）、`logPath()`（`:937-939`，`SESSION_FORMAT_VERSION` = 4）。

**本机实测验证**（逐字吻合）：

| header 里的 `cwd` | 磁盘目录名 |
|---|---|
| `<repo>` | `--<repo-slug>--` |
| `<other-project>` | `--<other-project-slug>--` |
| `<other-project>` | `--<other-project-slug>--` |

**⚠️ 三个特性使目录名不可用于反推 cwd**（注释原文 `:870-871`："Separator replacement and truncation are intentionally **lossy**, following the common human-navigable project-directory convention."）：
1. 分隔符折叠 → `a\b` 与 `a:b` 与 `a/b` 生成同名 key；
2. 截断到 251 字符 → 长路径丢失尾部；
3. 非安全字符转义 `~XXXX`，且原路径里真实的 `~` 也会被转义（`~002F` 之类），肉眼不可读。

### 1.3 会话首行/元数据字段证据（实测解码）

本机 `--<repo-slug>--/session-eef9c4ef-…/session.v4.jsonl.zstd` 的**第一个 zstd 帧**（即 header 行）解码结果：

```json
{"type":"session","version":4,"id":"session-eef9c4ef-7563-40b4-bc4c-95b997a00bbc",
 "createdAt":1790915242425,
 "cwd":"<repo>",
 "isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

子代理（subagent）会话多两个字段（同目录 `556e108c-a08a-480f-97bc-c93ed72fdaf6/session.v4.jsonl.zstd`）：

```json
{"type":"session","version":4,"id":"556e108c-a08a-480f-97bc-c93ed72fdaf6",
 "createdAt":1790915531644,
 "cwd":"<repo>",
 "parentSession":"session-eef9c4ef-…","isSeeded":false,
 "origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

> 注意：**子代理会话的目录名是裸 UUID**（`556e108c-…`），父会话是 `session-<uuid>`。这与 `README.md:72` 的"session ids injected escape"一致——id 本身就是 `session-<uuid>` 或 `<uuid>` 两种拼法。UI 侧 `sessionVisible()` 首行 `if (session.origin === "subagent") return false` 使其永不显示（见 §4.4）。

投影缓存同源（`$env:DSH_HOME\storages\session_projcache\sessions\<id>.json`，已抽样 2 个）：

```json
{ "version": 7,
  "record": {
    "identity": { "formatVersion": 4, "createdAt": 1790864339036,
                  "cwd": "<branch-repo>",
                  "isSeeded": true, "inheritedEventCount": 22 },
    "rows": { "title": {...}, "titleInput": {...}, ... } } }
```

字段 schema 出处：`dsh-session-projection-cache/lib/index.js:52`（`cwd: z.string().optional()`）、`:368`（写入 `...header.cwd === void 0 ? {} : { cwd: header.cwd }`）。

### 1.4 判定逻辑的代码证据（权威）

`dsh-workspace/lib/index.js:872-890` `indexHeader()` —— 把 header 的 cwd 变成 workspace 归属键：

```js
async indexHeader(header) {
	this.headers.set(header.id, header);
	this.sessionPaths.delete(header.id);
	if (header.cwd === void 0) {
		this.invalidSessionPaths.set(header.id, "header has no cwd");
		return;
	}
	try {
		const path = await realpathNormalize(header.cwd);
		if (!(await stat(path)).isDirectory()) {
			this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`);
			return;
		}
		this.sessionPaths.set(header.id, path);      // ← 唯一成功的落点
		this.invalidSessionPaths.delete(header.id);
	} catch {
		this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`);
	}
}
```

`:102-104` 成员投影（注意这是 **getter，每次读都过滤**）：

```js
get sessionIds() {
	return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);
}
```

`:111-129` `attachSession()` —— 加入工作区时的三重校验，缺一即抛错：

```js
const header = await this.host.readSessionHeader(sessionId);
if (header.cwd === void 0) throw new Error(`... its stored header carries no cwd to validate against`);
cwd = await realpathNormalize(header.cwd);            // 解析失败 → 抛
if (!(await stat(cwd)).isDirectory()) throw ...;      // 不是目录 → 抛
if (cwd !== this.record.path) throw ...;              // 不等于 workspace.path → 抛
```

唯一性 canon 出处 `:35-51`（`realpathNormalize`，`fullyQualifiedWorkspacePath` 先挡相对路径）：
> "`fs.realpath` … This is the **ONE uniqueness canon** of the package — workspace paths are stored canonicalized, uniqueness is **string equality of canonicalized paths**（a symlink to an existing workspace's directory collides），and attach-time session `cwd` checks go through the same canon."

⇒ **Windows 上的含义**：大小写差异由 `realpath` 归一；但**未做大小写不敏感比较**，是否碰撞取决于 `fs.realpath` 在 NTFS 上的返回拼写。若插件要自己比对路径（例如用 `sessionPersistence.list()` 反查），**必须自己走 `realpath`**，不能直接字符串比。

### 1.5 用户切换工作区时旧会话怎么办

**答：旧会话原地不动，仍归属旧 cwd 的 workspace。**

- `cwd` 在**创建时固化进 header**，而 header 是不可变的：`:57-61` 注释原文 "Validation is skipped when the settled snapshot already accounts the id: **the cwd fact was checked when it first attached and both inputs (stored header cwd, workspace path) are immutable**."
- "切换工作区"在 DSH 里 = **新建一个会话** → 新 header、新 session id、新目录。旧会话与新会话**没有从属关系**。
- `fork()` 会**继承 cwd**：`dsh-session/lib/index.js:1893-1901`
  ```js
  return this.create(childSessionId, {
    seed, inheritedEventCount: …,
    meta: { ...liveSource.header.cwd !== void 0 ? { cwd: liveSource.header.cwd } : {},
            parentSession: liveSource.id, isSeeded: true },
  });
  ```
  所以 **fork 出的子会话仍在同一工作区**；但 `archived-session-gate` 注释指出："a **fork** of an archived Session is an **independent conversation**"（见 §4.6）。
- 一个会话**只能属于一个工作区**（`README.md:73`："A session can only belong to one project."），且启动期 `validateStoredState()`（`:849-853`）会 fail-loud 拒绝"同一 session 被两个 workspace 记账"。

---

## 2. 工作区注册表 `workspace.json`

### 2.1 结构与本机实测

文件：`$env:DSH_HOME\storages\workspace.json`（7,925 字节）

```json
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": [ "2ffaa3c3-…", "8c1bd258-…", "7e411868-…" ],   // 3 个，权威显示顺序
    "archivedSessionIds": [ "session-86218f01-…", … ],              // 96 个（见下方更正）
    "pinnedSessionIds": []                                          // 0 个
  },
  "tables": {
    "workspaces": {
      "7e411868-46b4-4292-a768-2351b53d6d94": {
        "path": "<other-project>",
        "title": "Optimization-of-Heating-Recipe-for-Rotor-Thermal-Assembly",
        "sessionIds": [ "session-33183c16-…", "session-0d2a4661-…", "session-50ea23b6-…" ],
        "createdAt": "2026-09-12T06:40:33.379Z",
        "updatedAt": "2026-09-23T02:42:27.809Z"
      },
      "8c1bd258-4b5c-4ac4-9757-187cd2a1f61b": {
        "path": "<branch-repo>",
        "title": "plugin-1",
        "sessionIds": [ … 21 条 … ],
        "createdAt": "2026-09-29T14:44:21.537Z",
        "updatedAt": "2026-10-02T03:06:48.984Z"
      },
      "2ffaa3c3-4924-43d1-9dbf-f4765feafcda": {
        "path": "<repo>",
        "title": "plugin-2",
        "sessionIds": [ "session-eef9c4ef-7563-40b4-bc4c-95b997a00bbc" ],
        "createdAt": "2026-10-02T04:27:22.396Z",
        "updatedAt": "2026-10-02T04:27:22.437Z"
      }
    }
  }
}
```

实测计数（`node .recon\count.mjs`）：
```
archivedSessionIds length = 96     (unique = 96)
pinnedSessionIds length   = 0
workspaceIds length       = 3
tables.workspaces count   = 3
unit = {"name":"workspace","version":2}
defaultWorkspaceId present = false
pendingMutation present    = false
```

> **更正 `00-lead-verified-facts.md:75`**：该处写"`global.archivedSessionIds` 已有 **97** 个"。本轮两次独立读取（PowerShell `ConvertFrom-Json` 与 Node `JSON.parse`）均为 **96**（去重后仍 96）。可能是 `00` 号报告统计后的增量或计数口径差异，建议以 96 为准。

**schema 出处**（`dsh-workspace/lib/index.js`，与 `lib/types/spec.js` 等价）：
- `:209-215` `workspaceRecord`：`{ path, title, sessionIds, createdAt, updatedAt }`（`path` 是 create 时盖的 `fs.realpath` canon；`sessionIds` **数组顺序即显示顺序**；时间戳是 ISO-8601 字符串）
- `:240-248` `workspaceDomainState`：`{ initialized, defaultWorkspaceId?, workspaceIds, archivedSessionIds, pinnedSessionIds, pendingMutation? }`
- `:255-268` `defineDomain({ name: "workspace", version: 2, global: {...}, tables: { workspaces: domainTable(workspaceRecord) } })`
- `:221-227` `workspacePendingMutation`：`{operation:'create'|'delete', workspaceId}` 的可恢复双写标记

> 本机 `defaultWorkspaceId` 与 `pendingMutation` 均**不存在**——前者说明首次自动建工作区已停用（`:426` 一旦 `defaultWorkspaceId` 被设过就永不再自动创建），后者说明当前无中断的双写。

### 2.2 责任包划分

| 层 | 包 | 服务名 | 职责 |
|---|---|---|---|
| 权威存储 | `dsh-workspace` | `ctx.workspaceRegistry` | **唯一**打开 `workspace` domain、执行全部写、持有 `entities` 缓存与 `sessionPaths` 索引 |
| RPC 投影 | `dsh-api-workspace-controller` | `ctx.workspaceController`（namespace `workspace`） | **只读** registry + 发 `workspace/follow` 流；**不直接写文件** |
| 客户端 | `dsh-api-workspace-controller/lib/client.js` | `ctx.workspaces` | 客户端服务门面，转发到 Remote |

`dsh-workspace/lib/index.js:354-355`：
```js
var WorkspaceRegistry = class extends Service {
	static inject = ["storageDomain", "sessionPersistence"];   // ← 两个强制依赖
```
注释 `:347-353`：
> "Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. **The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history** and commit the initialized marker."

⇒ 插件要拿工作区信息，**必须注入 `workspaceRegistry`**（它会自己拉 `storageDomain`+`sessionPersistence`），不要自己去 `storageDomain.open(workspaceDomainSpec)`。

### 2.3 何时写入（全部写点）

| 操作 | 代码位置 | 写序 |
|---|---|---|
| `create(path,title)` | `:406-410` → `createCanonical` `:639-702` | ① global 写 `pendingMutation:{operation:'create'}` → ② `table.put(id, record)` → ③ global 写 `{pendingMutation:undefined, initialized:true, workspaceIds:[id,...]}`。任一步失败按逆序回滚，双失败抛 `AggregateError` 并保留可恢复标记 |
| `delete(id)` | `:467-469` → `deleteKnown` `:703-739` | ① global 写 `pendingMutation:{operation:'delete'}` → ② `entities.delete(id)` → ③ `table.delete(id)` → ④ global 写清标记。②之后的失败会恢复 entity 与 state |
| `attach/detach/insertSessionBefore/setTitle` | `entity.js:54-113` → `mutate()` `entity.js:136-154` | 单个 `table.update(id, fn)`；`fn` 在**写链槽位**上看到当时值 → 竞态安全的 read-modify-write；同时盖 `updatedAt` 并按 canonical cwd **prune** 掉不再合规的 id |
| `archive/unarchive/pin/unpin Session` | `:524-605` | 只写 `global`（`archivedSessionIds` / `pinnedSessionIds`） |
| `insertBefore(id, beforeId)` | `:477-497` | 只写 `global.workspaceIds` |
| 启动 | `:377-394` `Service.init()` | `storageDomain.open` → `recoverPendingMutation` → `validateStoredState` →（首次）`listStoredHeaders` + `replaceHeaderIndex` + `bootstrap(headers)` → `indexLiveSessions` → `rebuildEntities` → `reportFilteredCandidates` |

**`bootstrap` 是"历史会话自动建工作区"的地方**（`:756-830`）：按 canonical cwd 把磁盘上所有会话分组，为没有 workspace record 的路径**新建** record（标题取路径末段），并按"组内最新会话时间"排 workspaceIds。**只在 `initialized === false` 时跑一次**（`:385-389`）。

**`enqueueOperation()`**（`:937-944`）是全局串行化闸门：每个 registry 操作都先 `recoverPendingMutation()` 再执行，尾部串接。

### 2.4 事件名：插件能订阅什么

#### (a) `domain/changed` —— 底层、可用、公开

`dsh-storage-domain/lib/index.js:214-219`（发出）：
```js
emitChanged(change) {
	try { this.ctx.emit("domain/changed", change); }
	catch (error) { this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`); }
}
```
形状 `{ domain, table, key, operation: 'put' | 'deleted', value? }`（`:162-173` global 用 `table:"" , key:""`；`:257-262` put；`:264-277` delete）。

**已有先例**（证明这是给消费者用的，不是内部实现）：
- `dsh-storage-domain/lib/invariant.js:19` —— `ctx.on("domain/changed", …)` 校验
- `dsh-workspace/lib/invariant.js:103` —— `ctx.on("domain/changed", …)` 校验 workspaces 表
- `dsh-api-workspace-controller/lib/types/feed.js:46` —— `ctx.on('domain/changed', (change) => { this.changed(change); })` 生产 follow 流

⇒ **插件订阅 `domain/changed` 可以拿到 workspace domain 的每一次提交**，包括 `table:''` 的 global 变更（里面就有完整的 `archivedSessionIds`）。

#### (b) `workspace/follow`（Remote 流）→ 五个增量帧

`dsh-api-workspace-controller/lib/types/feed.js:82-130` 把 domain change 翻译成：
```js
{ type: 'upsert', workspace }              // 新工作区 / record 变更
{ type: 'remove', workspaceId }            // 工作区被删
{ type: 'order', workspaceIds }            // 顺序变
{ type: 'archived', archivedSessionIds }   // 归档集变（:104-108）
{ type: 'pinned', pinnedSessionIds }       // 置顶集变（:109-113）
```
第一帧恒为 `{ type: 'baseline', value: { items, archivedSessionIds, pinnedSessionIds } }`（`:57-63, 74`）。客户端消费见 `dsh-api-workspace-controller/lib/client.js:473-511`（`acceptIncrement`）。

#### (c) 插件**提供**（不是消费）的两个归档准入事件

`dsh-workspace/README.md:101`：
> "Archive admission is a **capability seam over two Host events this package declares and dispatches**: **`workspace/session-activity`** (waterfall) asks the composed providers what still runs for a Session, and **`workspace/session-stop`** (parallel) asks them to stop it."

随附提供方：Agent 注册表（`turn`）、job 注册表接缝（`job`）、Subagent runtime（`subagent`）、Schedule 插件（`schedule`）。**空组合可以自由归档。**

#### (d) 没有的东西

- **没有** `workspace/added` / `workspace/removed` / `workspace/changed` 这类命令式 cordis 事件。
- **没有**任何文件系统监视事件。`dsh-workspace` 包内 grep `chokidar|fs.watch|watchFile|FSWatcher` → **0 命中**。

---

## 3. 删除工作区文件夹后的现状

必须区分两种"删除"，官方行为**不同**：

### 3.1 情形 A：只删磁盘文件夹，工作区还在注册表里

**答：(b) 的变体 —— 注册表不移除、会话文件留盘、不归档；但会话从该工作区分组**消失**并掉进"未分组"。没有报错。全部是惰性、只在下次刷新/重启时反映。**

逐步证据链：

**第 1 步** — 下次 `indexHeader()` 时 cwd 解析失败（`dsh-workspace/lib/index.js:879-889`）：
```js
try {
	const path = await realpathNormalize(header.cwd);   // ← 文件夹没了 → ENOENT → 进 catch
	...
	this.sessionPaths.set(header.id, path);
} catch {
	this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`);
}
```
⇒ `sessionPaths` 里**没有**这个 id。

**第 2 步** — `sessionIds` getter 把它们过滤掉（`:102-104`）：
```js
return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);
//                                              ↑ undefined !== record.path → 被滤掉
```

**第 3 步** — 但**持久化文件里的 id 没被删**（本机 `workspace.json` 中 plugin-1 的 `sessionIds` 有 21 条，而磁盘该目录有 144 个条目——记账与磁盘本就不同步，且过滤是纯读时行为）。真正的 prune 只发生在下一次 `mutate()`（`entity.js:141`），且 prune 条件同样是 `sessionPath(id) === path`，**所以一旦文件夹消失，下次任何写操作就会把这些 id 从 `record.sessionIds` 里永久剔除**。⚠️ 这意味着"文件夹消失"的信息**会自我销毁**——见 §6 风险 4。

**第 4 步** — 官方**明确记录了这个行为**，`dsh-workspace/README.md:73`：
> "A session joins the project of the directory it runs in… A session can only belong to one project. **A session whose directory cannot be validated — no recorded directory, or a moved or deleted folder — cannot join and stays ungrouped.**"

**第 5 步** — 诊断日志（`:900-910` `reportFilteredCandidates()`）：
```js
const reason = this.invalidSessionPaths.get(sessionId)
	?? (this.headers.has(sessionId) ? `canonical cwd '${path}' differs from workspace path '${record.path}'` : "session header is missing");
this.ctx.logger.warn(`workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`);
```
（这行日志是**唯一的运行时可见信号**，且只在启动时打一次。）

**第 6 步** — UI 后果。`workspaceView()` 用 `[...workspace.sessionIds]`（`feed.js:14`），即走 getter → 客户端看到空数组。`dsh-client-ui-workspace/lib/client.js:420-437`：
```js
function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
	const accounted = new Set();
	… workspaces.forEach(w => w.sessionIds.forEach(id => accounted.add(id))) …
	const stray = list.ids.map(id => list.byId[id])
		.filter(s => s !== undefined && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter));
	if (stray.length > 0) groups.push(buildGroup("", undefined, undefined, undefined, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));
	…
}
```
⇒ 会话进 `key: ""` 的 **Ungrouped** 组（label `group.ungrouped` = "未分组"，:3869 / "Ungrouped"，:3984）。

**第 7 步** — 注册表里的 workspace record **保留**，`status()` → `'missing-dir'`；**但没人问**（§6 有全 asar 扫描证据）。

**第 8 步** — 会话文件**原封不动**：
- `dsh-session-persistence/README.md:152`："**No deletion or retention API** — pruning stored sessions is out-of-band backend maintenance."
- `dsh-session-persistence-jsonl/README.md:163`："**Nothing deletes session files** — logs accumulate under `root` until removed externally; **the seam has no deletion API**."

**第 9 步** — 官方自认这是"延迟可见"的，`dsh-workspace/README.md:173`：
> "**External changes are seen late** — if another process deletes or damages a directory, the project **reflects it only at the next refresh or restart**."

⚠️ **补充一个官方没写的坑**：`status()` 的 catch 分支（`entity.js:118-122`）把所有 `stat` 失败等价为 `'missing-dir'`：
```js
catch {
	// Any stat failure (ENOENT, dangling parent, permission loss) means the
	// directory is not usable right now; the record itself never mutates.
	return 'missing-dir';
}
```
⇒ **网络盘短暂离线 / 权限临时丢失会与"真的删了"不可区分**。

### 3.2 情形 B：在 UI 里"移除工作区"（注册被删）

**答：官方**明确定义**为"保留文件夹 + 保留全部会话日志，会话退到未分组"。**

代码 `dsh-workspace/lib/index.js:459-469`（JSDoc 原文）：
```js
/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id) { return this.enqueueOperation(() => this.deleteKnown(id)); }
```

UI 文案（`dsh-client-ui-workspace/lib/client.js`）：
- `:3916` 中文："将把"{name}"从工作区列表中移除。**文件夹与会话记录会保留，其会话将显示在"未分组"下。**"
- `:4031` 英文："This removes "{name}" from the workspace list. **The folder and session logs will be kept. Its sessions will appear under Ungrouped.**"

README 两处呼应：
- `:77`："Remove a project when it is no longer needed: it leaves the list, and **its folder, files, and session histories are never touched — those sessions become ungrouped**. Adding the same directory again afterwards **starts a fresh project without the old sessions**."
- `:171`（已知限制）："**Removal never deletes data** — removing a project leaves its folder, files, and session histories in place; **those sessions become ungrouped**, and session deletion or folder removal are separate, absent capabilities"

### 3.3 本机实证：孤儿会话目录确实存在

`$env:DSH_HOME\sessions\` 下有 **5 个**项目目录：

| 目录 | 在 `workspaceIds` 里？ |
|---|---|
| `--<branch-repo-slug>--` | ✅ `8c1bd258-…` |
| `--<repo-slug>--` | ✅ `2ffaa3c3-…` |
| `--<other-project-slug>--` | ✅ `7e411868-…` |
| `--<other-project-slug>--` | ❌ **不在** |
| `--<other-project-slug>--` | ❌ **不在** |

两个孤儿目录里的会话 header 证明 cwd 仍指向各自目录：
```
session-642f9e4c-…  cwd = "<other-project>"
session-86218f01-…  cwd = "<other-project>"
```
且这两个 session id **都在** `archivedSessionIds` 里（96 条中的 2 条）——说明它们是**被用户手动归档过**的，与"工作区被移除"是两件独立的事。这正好构成本需求的核心难点样本（§6 风险 1）。

> 备注：`CourseSystem` 与 `NewToLearn` 的文件夹本身是否还在磁盘上，本轮**未验证**（按纪律不去 stat/触碰用户数据之外的东西；不过 `status()` 不适用于未注册的工作区）。这不影响结论：**目录在、注册不在、会话文件在、无人归档也无人恢复**。

### 3.4 小结表：三种状态对比

| 触发 | registry record | `sessionIds` | `archivedSessionIds` | 会话文件 | UI |
|---|---|---|---|---|---|
| 文件夹被删（注册还在） | 保留，`status()`=`missing-dir` | **读时被滤空**（下次 mutate 永久 prune） | **不变** | 保留 | 会话掉到"未分组" |
| 在 UI 移除工作区 | **删除** | record 一起没了 | **不变** | 保留 | 会话掉到"未分组" |
| 用户手动归档会话 | 不变 | 不变（**保留槽位**） | **+1** | 保留 | 默认滤镜下**隐藏** |

---

## 4. 归档/恢复概念是否已存在？

**答：完整存在，是一等公民。** 不但有字段，还有 Host API、Remote RPC、客户端服务、菜单、快捷键、三态滤镜、运行中会话的准入闸门。**没有** trash / 回收站 / 真删除。

### 4.1 存储字段

`workspace.json` → `global.archivedSessionIds: string[]`（归档顺序），本机 **96 条**。schema `dsh-workspace/lib/index.js:245`：`archivedSessionIds: z.array(sessionId).default([])`。

语义（`:498-506` JSDoc 原文）：
> "The registry-global archive set: **sessions hidden from every grouping surface**. **Archiving never touches workspace accounting** — an archived session **keeps its `sessionIds` slot** so unarchiving restores its position. @returns the archived session ids in archive order."

`:231-238` 补充：
> "`archivedSessionIds` is the registry-global archive set layered over workspace accounting: an archived session keeps its `sessionIds` slot (**unarchiving must restore the position**), **so the set never participates in the one-owner accounting invariant**. `pinnedSessionIds` … **pinning and archival are mutually exclusive**, so archiving drops the session's pin. Both session sets are defaulted so records written before the fields parse unchanged."

### 4.2 Host API（`dsh-workspace/lib/index.js`）

```js
get archivedSessionIds()            // :504  只读，归档顺序
archiveSession(sessionId, options)  // :524  幂等
unarchiveSession(sessionId)         // :551  幂等，不查存在性
get pinnedSessionIds()              // :566
pinSession / unpinSession           // :576 / :596
```

`archiveSession` 全貌（`:524-540`）：
```js
archiveSession(sessionId, options = {}) {
	return this.enqueueOperation(async () => {
		if (this.requireState().archivedSessionIds.includes(sessionId)) return;   // 幂等快路
		if (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId, "archive");
		if (options.stopActivity !== true) {
			const activity = await this.ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
			if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity);
		}
		const state = this.requireState();
		await this.setState({
			...state,
			archivedSessionIds: [...state.archivedSessionIds, sessionId],
			pinnedSessionIds: state.pinnedSessionIds.filter((id) => id !== sessionId)   // ← 同写清 pin
		});
		if (options.stopActivity === true) await this.stopSessionActivity(sessionId);
	});
}
```

`sessionKnown()`（`:612-617`）—— 会话必须 **live 或 在 persistence 里**：
```js
async sessionKnown(id) {
	if (this.ctx.get("sessions")?.get(id) !== void 0) return true;
	if (this.headers.has(id)) return true;
	await this.indexHeaders(await this.listStoredHeaders());
	return this.headers.has(id);
}
```

**四个相关错误类型**（都可精确捕获）：
- `WorkspaceUnknownSessionError`（`:290-301`）—— 归档一个 live 与 persistence 都不认识、也不在 header 索引里的 id
- `WorkspaceActiveSessionError`（`:307-320`）—— 有活动且未传 `stopActivity`，`.activity` 列出各 provider 的报告
- `WorkspaceArchivedSessionPinError`（`:322-332`）—— 试图 pin 一个已归档会话
- `WorkspaceMoveInvalidError` / `WorkspaceOrderInvalidError`

### 4.3 Remote / 客户端 API

Remote（typert，`dsh-api-workspace-controller/lib/typert.host.js`）：
`workspace/archiveSession`（`:264-284`）、`workspace/unarchiveSession`（`:472-492`）、`workspace/pinSession`、`workspace/unpinSession`、`workspace/create`、`workspace/delete`、`workspace/rename`、`workspace/insertBefore`、`workspace/insertSessionBefore`、`workspace/follow`、`workspace/initializeDefault`。

类型声明（`:666-670`）：
```ts
export interface WorkspaceArchiveValue { readonly archivedSessionIds: readonly SessionId[]; }
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[];
  readonly archivedSessionIds: readonly SessionId[];
  readonly pinnedSessionIds: readonly SessionId[];
}
export type WorkspaceFollowIncrement =
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type: 'pinned'; readonly pinnedSessionIds: readonly SessionId[] };
```

客户端服务 `ctx.workspaces`（`dsh-api-workspace-controller/lib/client.js:381-437`）：
```js
var WorkspaceController = class extends Service {
	constructor(ctx, model) { super(ctx, "workspaces"); … }
	async delete(workspaceId) { … }
	async archiveSession(sessionId, options = {}) {
		const result = await this.model.archiveSession(sessionId, options);
		if (!result.ok) throw new WorkspaceArchiveError(result.error);   // :371-379
	}
	async unarchiveSession(sessionId) { … }
	async pinSession(sessionId) { … }
	…
};
```
`inject = ["remote", "remote.workspace"]`（`:445`）。
错误码：`workspace/session-active`（`details.activity` 按族列出）、`workspace/not-found`、`workspace/invalid-path`、`workspace/name-conflict`、`workspace/move-invalid`。

### 4.4 侧栏（`dsh-client-ui-sidebar`）如何筛选展示

**关键澄清：`dsh-client-ui-sidebar` 只是外壳，不做会话分组。** 全文 536 行，导出的是 `HeaderLeadingControls`（`:38-73`，折叠侧栏时的窗口控件）与 `SidebarRoot`（CSS + 面板容器）。截图级证据 `:149` 注释："…The **workspace/session browsing region** between…" —— 该 region 由 `dsh-client-ui-workspace` 填充。

**真正的分组在 `dsh-client-ui-workspace/lib/client.js`：**

视图形状（store，`:658-707`）：
```js
return defineStore({
	init: () => ({
		groupBy: "workspace",        // 'workspace' | 'workspace-tree' | 'flat'
		orderBy: "updated",          // 'updated' | 'manual'
		groupExpansion: {},
		sessionOrderByAccount: {},
		archivedFilter: "default"    // ★ 三态：'default' | 'show' | 'only'
	}),
	persist: "dsh.workspace.view.v5",
	actions: { setArchivedFilter: (d, filter) => { d.archivedFilter = filter; }, … }
});
```

**可见性判定**（`:351-367`，注意 JSDoc 明说"their accounting slots remain either way so unarchiving restores position"）：
```js
function sessionVisible(session, current, archived, archivedFilter) {
	if (session.origin === "subagent") return false;              // 子会话永不显示
	if (session.blank && session.id !== current) return false;    // 只有当前空白会话显示
	switch (archivedFilter) {
		case "default": return !archived.has(session.id);         // ★ 默认隐藏已归档
		case "show": return true;
		case "only": return archived.has(session.id);
		default: return assertNever$1(archivedFilter);
	}
}
```

**排序**：`reconcileManualOrder()`（`:301-340`）把结果拼成 `[...pins, ...ordered, ...ordinary, ...archives]` —— **归档会话排在最后**（`:320-328`）。

**有没有"已归档"分组？** **没有独立分组区**。归档会话只是被滤镜**藏起来**（default）、**留原位**（show）或**只留它们**（only）。UI 文案（三态）见 `dsh-client-ui-workspace` locale："隐藏已归档（默认）/ 全部对话（显示已归档）/ 仅已归档"。

**按工作区过滤**：`groupByWorkspace()`（`:420-437`）先按 `workspace.sessionIds` 建组，剩余进 Ungrouped（key `""`）。`workspace-tree` 模式用 `nestWorkspaces`（`:3288`）做目录嵌套。

**归档入口**（全部在 `dsh-client-ui-workspace`）：
| 入口 | 位置 |
|---|---|
| 行菜单项 `ArchiveSessionMenuItem` | `:3424-3441`（`:3435` 文案 `menu.archiveSession` / `menu.unarchiveSession`） |
| 行内按钮 `ArchiveSessionRowButton` | `:3443-3460` |
| 快捷键 `session.archive` = **Ctrl+Shift+A** | `:193-201`（`register("session.archive", () => t("menu.archiveSession"), ["archive session"], "KeyA", ["primary","shift"], ["primary","alt"], …)`） |
| 服务门面 | `:861-866`（`await this.workspaces.archiveSession(sessionId, options)`） |
| 运行中确认 | `:4227`（`await uiWorkspace.archiveSession(sessionId, { stopActivity: true })` 走"停止并归档"确认流） |
| undo / toast | `:4254`（`undoArchive: unarchiveSession`） |
| locale | `:3919-3920` "归档会话 / 取消归档"；`:4034-4035` "Archive session / Unarchive session" |

### 4.5 `dsh-session-reference` / `dsh-session-query` 提供哪些按工作区查询会话的接口

#### `dsh-session-query`（推荐入口，有**原生 cwd 过滤**）

`lib/index.js:655-658`：
```js
function filterSessionResults(records, filters = []) {
	const predicates = filters.map(sessionPredicate);
	return records.filter((record) => predicates.every((predicate) => predicate(record)));
}
```
`:751-765` **filter 种类**：
```js
function sessionPredicate(filter) {
	switch (filter.kind) {
		case "id":          return (record) => filter.values.includes(record.header.id);
		case "cwd":         return (record) => filter.values.includes(record.header.cwd ?? null);   // ★ 按 cwd 精确匹配
		case "created-at":  return (record) => matchesRange(record.header.createdAt, validateRange(...));
		case "parent":      return (record) => filter.values.includes(record.header.parentSession ?? null);
		case "availability":return (record) => filter.values.some(v => v === "live" ? record.live : record.persisted);
		default: return unknownFilter(filter);
	}
}
```
`:682-685` 校验 cwd 子句：`values` 是 `(string|null)[]`。事件级另有一套 filter（`seq`/`time`/`type`/`surface`/`text`，`:766-789`）。
导出面（`:1240`）：`SessionQueryEngine`、`filterSessionResults`、`materializeSessionResultFilters`、`buildSessionEventSearchDocuments`、`readColdSessionLog` 等。

> ⚠️ `cwd` filter 做的是 **`record.header.cwd` 的字符串精确比较**，**没有走 `realpath`**。所以插件用 `workspace.path`（已被 realpath 归一）去匹配时**可能不等**（大小写、扩展长度路径前缀、尾斜杠、symlink）。必须自己做归一化，或改用"取 record.header.cwd 再 realpath 后比较"。

#### `dsh-session-reference`

README `:42`：
> "`listCandidates(agent, query?, limit?)` lists sessions other than the agent's own, filters case-insensitively by id, working directory, projected title, or display title, and **ranks same-directory sessions first**. Each candidate carries its latest title as `label`…"

用途是"引用另一个会话"，**不是管理列表**；浏览器侧入口 `ctx.remote.sessionReferenceResolver.candidates`。已知限制 `:133-137` 明说"No body discovery"、"No live link"、"**not a model-facing search tool**"。**不适合**本需求做批量枚举。

#### `dsh-session-persistence`（最完整的批量枚举）

README `:36-45`：
```text
const handle = await ctx.sessionPersistence.create(header)
const handle = await ctx.sessionPersistence.open(id, 'write')
const reader = await ctx.sessionPersistence.open(id, 'read')
const snap   = await ctx.sessionPersistence.stat(id)   // header + revision (+eventCount/sizeBytes)，不读日志
const all    = await ctx.sessionPersistence.list()     // 每个可见已存会话一个快照
await ctx.sessionPersistence.flush()
```
- `list()` / `stat()` **只读最高 generation 的 header，不读事件行**（`dsh-session-persistence-jsonl/README.md:82`）→ **低成本枚举全部历史会话的 `id` + `cwd` + `createdAt`**。
- 已知限制（`:153`）："**`list()` is unpaginated and unfiltered** — it returns every stored session's snapshot; fine for local stores, unindexed at scale."
- `WorkspaceRegistry.listStoredHeaders()`（`dsh-workspace/lib/index.js:891-894`）就是这个用法：`(await this.ctx.sessionPersistence.list()).map(s => s.header)`。

#### 有没有现成的 `listByCwd(path)`？

**没有。** 需要自己组合：`ctx.sessionPersistence.list()` 拿 `header.cwd` → 自己 realpath 归一 → 比较；或 `ctx.sessionQuery` + `{kind:'cwd'}` filter（需同款归一化）。

### 4.6 归档的**强制**力：准入闸门（重要，容易漏）

`dsh-api-session-controller/lib/types/archived-session-gate.js`（全文关键部分）：
```js
/**
 * The controller's admission gate for archived Sessions: an archived
 * Session, or a subagent descendant of one, must not run a model step until
 * it is restored. … A late waking delivery to an archived Session — a
 * subagent settlement, a queued follow-up — proposes a step the gate rejects,
 * which the loop ends as `blocked` without a request; unarchiving lifts the
 * gate for the whole lineage.
 */
export const ArchivedSessionGate = {
	name: 'archived-session-gate',
	inject: ['agents', 'sessions', 'workspaceRegistry'],
	apply(ctx) {
		ctx.on('agent/pre-step', (payload, next) => underArchivedSession(ctx, payload.agent)
			? Promise.resolve({ kind: 'reject' })
			: next());
	},
};

export function underArchivedSession(ctx, agent) {
	const archived = ctx.workspaceRegistry.archivedSessionIds;
	let header = agent.session.header;
	const visited = new Set();
	while (!visited.has(header.id)) {
		if (archived.includes(header.id)) return true;
		visited.add(header.id);
		if (header.origin !== 'subagent' || header.parentSession === undefined) return false;
		const parent = ctx.sessions.get(header.parentSession);
		if (parent === undefined) return archived.includes(header.parentSession);
		header = parent.header;
	}
	return false;
}
```
⇒ 归档**真的会阻止会话继续跑**（`agent/pre-step` 被 reject，loop 以 `blocked` 收尾），且沿 subagent 血缘向上查。**但"fork 出来的会话是独立对话"，不受父归档影响。**
⇒ `underArchivedSession` 是**导出函数**，插件可复用。

### 4.7 不存在的东西

| 概念 | 状态 |
|---|---|
| trash / 回收站 | **没有**（`dsh-session-persistence` README:152 "No deletion or retention API"） |
| 真删除会话 | **没有**（`dsh-session-persistence-jsonl` README:163 "Nothing deletes session files"） |
| Remote `session/delete` | **没有**（plugin-1 实证：sessionController 远端只有 list/search/create/selectModel/rename/fork/prompt/cancel/page/follow/projections/control） |
| `hidden` 独立字段 | **没有**；`hidden` 只是 README 对 archive 的散文同义词（`README.md:75` "Hiding and restoring sessions"） |
| 归档原因 / 来源标记 | **没有** —— `archivedSessionIds` 是纯 id 数组，**无法区分"用户手动归档"与"插件自动归档"** ★ |
| 归档时间戳 | **没有**（README:116 "Archive and pin sets contain Session id strings, default to empty, and **carry no per-entry objects or timestamps**"） |

---

## 5. 可用挂点清单

### 5.1 官方公开契约（稳，有 JSDoc / typert 声明 / README）

| 挂点 | 位置 | 签名 / 形状 | 备注 |
|---|---|---|---|
| `ctx.workspaceRegistry.list()` | `dsh-workspace:452-458` | `→ Workspace[]`（按 registry order） | 同步，无 I/O |
| `.get(id)` | `:443-445` | `→ Workspace \| undefined` | |
| `.archivedSessionIds` | `:504-506` | `→ readonly SessionId[]` | |
| **`.archiveSession(id, opts?)`** | `:524-540` | `(sessionId, {stopActivity?:boolean}) → Promise<void>` | **归档的唯一正确写入口**；幂等 |
| **`.unarchiveSession(id)`** | `:551-560` | `(sessionId) → Promise<void>` | **恢复的唯一正确写入口**；幂等、不查存在性 |
| **`ws.status()`** | `:154-160` / `entity.js:114-123` | `→ Promise<'ok' \| 'missing-dir'>` | **探测文件夹是否还在的官方原语**；README:99 记作 "directory status"；⚠️ catch 吞掉所有失败类型 |
| `ws.path` / `ws.title` / `ws.sessionIds` / `ws.createdAt` / `ws.updatedAt` / `ws.id` | `:90-104` | `sessionIds` **已按 canonical cwd 过滤** | |
| `ws.attachSession(id)` / `detachSession(id)` | `:111-153` | | 会 fail-loud 校验 cwd |
| `resolveByPath(path)` | `:635-638` | `→ Promise<Workspace \| undefined>` | ⚠️ 路径不存在会在 `realpath` 里 **reject** |
| `create(path, title?)` | `:406-410` | | 相对路径 / 不存在 / 非目录 → reject |
| `delete(id)` | `:467-469` | `→ Promise<boolean>` | 只删注册，保留文件夹与会话 |
| `ctx.sessionPersistence.list()` | `dsh-session-persistence` README:43 | `→ Promise<Snapshot[]>`，`snapshot.header` 含 `cwd` | 不分页不过滤 |
| `.stat(id)` | 同上:42 | header + revision，**不读事件行** | |
| `ctx.sessionQuery` + `{kind:'cwd'}` | `dsh-session-query:751-765` | `filterSessionResults(records, filters)` | ⚠️ 字符串精确比较，不 realpath |
| `ctx.sessions.get(id)` / `.list()` | `dsh-session:1861-1870` | live 会话 | |
| **`domain/changed`** | `dsh-storage-domain:214-219` | `{domain, table, key, operation, value?}` | 可订阅；有 3 处官方先例 |
| `workspace/follow` 增量 | `feed.js:82-130` | `upsert/remove/order/archived/pinned` | Remote 流 |
| `ctx.fs.watch(target, changed, signal)` | `dsh-fs` README（"watch targets"）+ `dsh-fs-local:726-750` | `→ Promise<unwatch>` | **chokidar 实现**；`depth:0`、`ignoreInitial:true` |
| `underArchivedSession(ctx, agent)` | `archived-session-gate.js`（导出） | `→ boolean` | 可复用 |
| `workspace/session-activity` (waterfall) / `workspace/session-stop` (parallel) | `dsh-workspace` README:101 | 插件**提供实现** | 只有自己持有"活动"概念时才需要 |

**`ctx.fs.watch` 的关键细节**（`dsh-fs-local/lib/index.js:726-750`）：
```js
async watch(target, changed, signal) {
	signal.throwIfAborted();
	const path = resolve(this.processPath(target));
	const directory = (await this.stat(target, signal))?.type === "directory";
	signal.throwIfAborted();
	const root = directory ? path : dirname(path);   // ← 目标不存在 → stat undefined → 监视父目录
	const watcher = watch(root, { ignoreInitial: true, depth: 0,
		ignored: (entry) => !directory && resolve(entry) !== root && resolve(entry) !== path });
	watcher.on("all", (_event, entry) => { if (directory || resolve(entry) === path) changed(); });
	watcher.on("error", (error) => { changed(error instanceof Error ? error : new Error(String(error))); });
	try { await once(watcher, "ready", { signal }); return () => watcher.close(); }
	catch (error) { await watcher.close(); throw error; }
}
```
- `dsh-fs` README 的承诺："`watch(target, changed, signal)` reports invalidations for one file or a directory's **direct entries**… The signal cancels initialization; **unsupported providers reject without polling**."
- **目录存在时** `root = 该目录`，`depth:0` → 只能看到它自己**直接条目**的变化，**看不到目录本身被删除**（父目录的变化才包含它）。
- **目录不存在时** `root = dirname(路径)`，`ignored` 过滤到只剩该 path → 这个分支**恰好能感知"该目录被创建"**。
- ⇒ 要监视"工作区目录被删除"，**必须主动 watch 它的父目录**（`dirname(ws.path)`），官方这个封装不够用；`ctx.fs` 的契约只保证"目录的直接条目"，**删除目录本身是否算父目录条目变化需实测**（未证实）。

### 5.2 内部实现（脆弱，慎用）

| 项 | 为什么脆弱 |
|---|---|
| `dsh-workspace/lib/index.js` 是**单文件 bundle**（948 行压缩前合并） | 行号会随构建变；`src/` 分文件结构（`src/entity.ts`、`src/paths.ts`、`src/spec.ts`）**不在 asar 里**，只在注释里被引用 |
| `projectKey()` 目录 slug（`dsh-session-persistence-jsonl/lib/index.js:875-894`） | **未导出**，仅包内用于算路径。**插件绝不该复刻它**——一旦官方改 slug，你的目录名映射就废了。要用 `list()`/`status()` 而不是自己拼路径 |
| `WorkspaceRegistry` 的 `sessionPaths` / `invalidSessionPaths` / `reportFilteredCandidates` | 进程内私有 Map，**无任何公开读取口**；"哪些会话因 cwd 失效被过滤"**只能从 `logger.warn` 日志看到** |
| `workspaceDomainSpec` / 直连 `domainTable('workspaces')` | 官方做法是让 `WorkspaceRegistry` 代劳；自己 open 会跳过 `pendingMutation` 恢复、`validateStoredState` fail-loud、`enqueueOperation` 串行化，**极易写坏注册表** |
| `archivedFilter` store 的 persist key `dsh.workspace.view.v5` | 版本号已到 v5，会继续变 |
| 客户端行对象字段名 | **是 `id` 不是 `sessionId`**（`dsh-api-session-controller/lib/client.js:3505`：`byId[entry.sessionId] = { id: entry.sessionId, … }`）。plugin-1 为此踩过坑（`.verify/v25-archive-nodes.txt` 关键发现 1，误用 `row.sessionId` 导致 `workspace/archiveSession: wire field "request" failed boundary validation`） |
| `dsh-client-ui-workspace/lib/client.js` 单文件 4,425 行 | 同上 |

### 5.3 `storageDomain` 的写序要求（官方原文）

`dsh-storage-domain/lib/index.js:94-103`：
> "Runtime of one open domain: authoritative in-memory state, the single per-domain write chain, and change-event emission. **Reads are synchronous from memory; every write queues on the chain, awaits backend durability FIRST, then mutates memory, then emits `domain/changed`** — a rejected backend write leaves memory untouched (no divergence between reads and the medium), and **events carry values that equal the in-memory state at emission, in write order**."

代码印证：
```js
// :221-226  单条 per-domain 写链
enqueue(job) {
	if (this.disposing) return Promise.reject(new DomainError("closed", `domain '${this.name}' is closed`));
	const result = this.chain.then(job);
	this.chain = result.then(noop, noop);
	return result;
}
// :257-262  put
put(key, value) {
	return this.host.enqueue(async () => {
		await this.host.unit.putRecord(this.tableName, key, value);   // ① 先后端持久化
		this.records.set(key, value);                                  // ② 再改内存
		this.emitPut(key, value);                                      // ③ 再 emit
	});
}
// :278-287  update —— fn 在写链槽位上执行
update(key, fn) {
	return this.host.enqueue(async () => {
		if (!this.records.has(key)) throw new DomainError("missing-key", …);
		const next = fn(this.records.get(key));                        // ← 槽位当前值，竞态安全 RMW
		await this.host.unit.putRecord(this.tableName, key, next);
		this.records.set(key, next);
		this.emitPut(key, next);
		return next;
	});
}
```

**插件必须遵守的写序**（若自建 domain）：
1. `await ctx.storage.domain.open(spec)` 拿 domain（**唯一**入口）
2. `domain.global.set(v)` / `domain.table(n).put|update|delete` —— **这些已经是"先后端→再内存→再 emit"**，不要绕过去直接写文件
3. 需要 read-modify-write 时**必须用 `table.update(key, fn)`**，别用 `get` 再 `put`（会破坏串行性）
4. domain 关闭后新写 reject `DomainError('closed')`；用 `ctx.effect(() => () => domain.close(), '...')` 挂生命周期
5. schema 校验：`invalidRecords` 只允许 `'backup-and-skip'`（`:70-72`）；`global.schema` **不能接受 null**（`:74`，null 是 medium 的"从未写过"哨兵）

**但本需求根本不需要自建 domain** —— `archiveSession`/`unarchiveSession` 已经处理了写链、幂等、pendingMutation、活动检查。**唯一需要有状态的是"哪些 id 是本插件归档的"**（§6）。

### 5.4 迁移会话文件的既有工具函数

**答：没有，而且这条路不可行。**

- `dsh-session-persistence-jsonl` README:161："**The flat-file storage layout does not load** — use a separate root or move pre-release artifacts into the project/session directory layout before loading."
- 同 README:163："**Nothing deletes session files**… the seam has no deletion API."
- `dsh-session-persistence` README:152："**No deletion or retention API**"
- 会话的物理位置由 **header 的 `cwd`** 决定（`logPath(root, cwd, id, compression)`，`:937-939`），而 **header 不可变、committed events 从不重写**（README:76 "Committed events are never rewritten"）。
- 历史 generation 迁移（v0→v1→…→v4）是**包内自动**的（`README.md:82`），**不是给外部用的 API**。

⇒ **"把会话文件挪到新工作区目录"既没有工具，也不需要**。会话与工作区的绑定真相在 header 的 `cwd` 里，**移动文件并不会改变归属**（`indexHeader` 仍按 header.cwd 算），反而会让投影缓存失配（§6 风险 6）。

---

## 6. 缺口判定与实现骨架

### 6.1 缺口判定：**部分覆盖**

**已覆盖（可直接复用）**
1. 归档原语：存储字段 + 幂等 Host API + Remote RPC + 客户端服务
2. 归档的**强制力**：`agent/pre-step` 闸门真的会阻止会话继续跑
3. 探测原语：`WorkspaceEntity.status()` → `'ok' | 'missing-dir'`
4. "文件夹消失后保留数据"的既定语义（会话留盘、退到未分组）
5. 按 cwd 批量枚举会话（`sessionPersistence.list()` 只读 header；`sessionQuery` 有 cwd filter）
6. 目录监视能力（`ctx.fs.watch`，chokidar 后端）

**完全缺失（需求②的真正缺口）**

| # | 缺口 | 证据 |
|---|---|---|
| ① | **没有任何自动触发** | 全 asar 扫描 `archiveSession` 共命中 18 个文件，其中**全部**属于四类：① 定义 `dsh-workspace`；② RPC 管道 `dsh-api-workspace-controller`（`index.js`/`types/*`/`typert.*`）+ `dsh-api-remotes`/`dsh-cordis-client-runner` 的转发；③ 类型目录 `dsh-tool-cordis/lib/types/api-catalog.js`；④ **唯一真正发起调用的 UI** `dsh-client-ui-workspace/lib/client.js`（31 处）。**没有任何定时器、watcher、启动钩子或策略代码调用它** |
| ② | **`status()` / `'missing-dir'` 零调用方** | 全 asar 11,470 个可读文本文件扫描 `missing-dir` → **只有 4 处命中**：`dsh-workspace/lib/index.js:156,158`、`dsh-workspace/lib/types/entity.js:116,121`（+ `dsh-tool-cordis` 的 API catalog 类型声明）。**没有任何消费者** |
| ③ | **没有任何工作区目录监视** | `dsh-workspace` 包内 `chokidar|fs.watch|watchFile|FSWatcher` → 0 命中；README:173 自认 "External changes are seen late" |
| ④ | **没有"归档来源"标记** | `archivedSessionIds` 是纯 `string[]`，README:116 明说 "carry no per-entry objects or **timestamps**"。**无法区分用户手动归档 vs 插件自动归档** |
| ⑤ | 没有 path→sessions 的持久化反向索引 | `sessionPaths` 是**进程内内存 Map**，启动时重建；一旦业务侧被 prune 就永久丢失 |

### 6.2 候选骨架（事件 → 判定 → 落点）

```
┌─ 探测层 ────────────────────────────────────────────────────────────────┐
│                                                                          │
│  P1（最稳，必做）启动扫描 + 手动刷新时一次全扫                            │
│      for (const ws of ctx.workspaceRegistry.list())                      │
│          if (await ws.status() === 'missing-dir') → 待归档[ws.id] = ws.sessionIds
│      时机：ctx.on('ready') / Service.init 之后一次                                │
│                                                                          │
│  P3（推荐，低开销兜底）定时复核                                            │
│      ctx.setInterval(async () => { …同上… }, 30_000)                     │
│      N 个 workspace = N 次 stat，成本可忽略                                │
│      必须：连续 3 次 missing 且持续 ≥ 60s 才判定（去抖，见风险 3）           │
│                                                                          │
│  P2（可选，准实时）ctx.fs.watch(dirname(ws.path), cb, signal)             │
│      ⚠️ 必须监视父目录，不能监视 ws.path 本身（目录没了 watcher 就死了）      │
│      ⚠️ 删除后需重新挂 watcher；chokidar depth:0 在 Windows 上对           │
│         "父目录里某个子目录被删"是否可靠，本轮【未证实】                      │
│      建议 P1 + P3 为主，P2 只作加速                                          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ 判定层（必须幂等 + 绝不能跟用户抢方向盘）────────────────────────────────┐
│                                                                          │
│  状态 A（文件夹消失）：                                                    │
│     missing = (await ws.status()) === 'missing-dir'                      │
│     if (!missing) → 清 missingSince[ws.id]，结束                           │
│     去抖通过后：                                                          │
│        candidates = ws.sessionIds                        // ★ 必须在过滤前取！│
│        candidates = candidates.filter(id => !archived.has(id))  // 已归档跳过 │
│        selfArchived[ws.id] = candidates                  // 先记来源，再动手  │
│        for (id of candidates) await registry.archiveSession(id)           │
│                                                                          │
│  状态 B（文件夹回来）：                                                    │
│     if (missing || !selfArchived[ws.id]) → 结束                           │
│        ★ 恢复只恢复「本插件归档过的」∩「当前仍在归档集里的」               │
│        restore = selfArchived[ws.id].filter(id => archived.has(id))       │
│        for (id of restore) await registry.unarchiveSession(id)            │
│        delete selfArchived[ws.id]                                         │
│                                                                          │
│  ★ 关键：ws.sessionIds 会在文件夹消失后被 getter 过滤为空                 │
│     （甚至被下次 mutate 永久 prune）→ 必须在"消失那一刻"之前就缓存快照，     │
│     或在恢复阶段用 sessionPersistence.list() 的 header.cwd 反查兜底         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─ 落点层 ────────────────────────────────────────────────────────────────┐
│                                                                          │
│  归档：await ctx.workspaceRegistry.archiveSession(id)                     │
│        ├ 不带 stopActivity → 活动中的会话抛 WorkspaceActiveSessionError    │
│        │   → 捕获后跳过该 id（推荐：绝不主动打断用户正在跑的 turn）           │
│        └ 带 {stopActivity:true} → 会真的停掉 turn（破坏性，仅用户显式确认时用）│
│        ⚠️ 前置条件 sessionKnown(id)：必须在 ctx.sessions（live）或         │
│           sessionPersistence.list() 里。已归档的会直接 return（幂等安全）    │
│                                                                          │
│  恢复：await ctx.workspaceRegistry.unarchiveSession(id)                   │
│        └ 幂等、不查存在性，即使会话文件已被外部删除也不会抛错                 │
│                                                                          │
│  来源标记（本插件自己的 sidecar）：                                         │
│        { [workspacePath]: { path, archivedIds: string[], at: ISO } }      │
│        落点优先用自己的 storageDomain（遵守"先后端持久化→再内存→再 emit"）；  │
│        或退化为一个 json 文件。                                            │
│        ★ 写序：先写 sidecar（记"我要归档这些"）→ 再调 archiveSession         │
│        ★ 恢复时：先 unarchiveSession → 再清 sidecar 条目                    │
│          两个方向都让 sidecar 偏保守（宁可漏恢复，不要错恢复用户手动归档的）    │
│                                                                          │
│  批量限速：archivedSessionIds 是全局数组，每次归档都全量重写 global。        │
│        本机已 96 条，一个工作区可能几十个会话 → 串行 + 每次 await，          │
│        必要时分批（每批 5~10 个 + 小睡），避免长时占住 registry 写链。        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.3 风险点（必须写进设计文档）

| # | 风险 | 说明与缓解 |
|---|---|---|
| **1** | ★★★ **误恢复用户手动归档的会话** | `archivedSessionIds` 没有来源标记（README:116）。用户手动归档的会话与插件自动归档的在存储里完全同形。**必须**在插件侧维护"本插件归档过的 id 集合"，恢复时只取交集。**仅靠 `ws.sessionIds` 恢复会把用户几个月前手动归档的对话全部翻出来。** |
| **2** | ★★★ **订阅 `domain/changed` 收不到"文件夹没了"** | 文件夹消失**不写 registry**，因此不产生任何 `domain/changed`。事件只在 registry 被写时触发。**不要指望事件驱动**，只能用 P1 启动扫描 + P3 轮询 `status()`（或 P2 watch）。这是本需求最反直觉的一点。 |
| **3** | ★★ **`status()` 的失败类型不可区分** | `entity.js:118-122` 的 catch 把 ENOENT / 权限丢失 / 悬空父路径 / 网络盘离线**一律**归为 `'missing-dir'`。网络盘（NAS/OneDrive）短暂抖动会误判 → **必须去抖**（连续 N 次 + 最短持续时间 + 失败不重置计数器）。 |
| **4** | ★★★ **`ws.sessionIds` 会自我销毁** | 文件夹消失后 getter 立刻返回空（`:102-104`）；更糟的是**下一次任何 workspace 写操作**（`entity.js:141` 的 prune）会把失效 id **从持久化 record 里永久删除**。⇒ 插件**必须在文件夹消失的第一时间缓存 id 列表**；一旦错过，只能退化为用 `sessionPersistence.list()` 的 `header.cwd` 反查（需自己做 `realpath` 归一化，Windows 大小写/拼写风险）。 |
| **5** | ★★ **文件夹重命名 = 消失 + 新增** | `attachSession` 会因 `cwd !== record.path` 抛错（`:122`）。会话的 cwd 是旧的，**不会跟着重命名走**。⇒ 重命名场景下"自动恢复"会把会话恢复进一个**路径已不存在**的旧 workspace。**建议**：恢复只在**同一 `path` 字符串重新出现**时触发；对 `missing-dir` 的 workspace 只归档不恢复。 |
| **6** | ★★ **投影缓存一致性** | `session_projcache/sessions/<id>.json` 按 **session id** 命名（不是 cwd），归档不动它，本身安全。但若插件**挪动会话文件**（强烈不建议），`record.identity.cwd` 便与磁盘位置不一致，而水合判定是 `stored.cwd === expected.cwd`（`dsh-session-projection-cache/lib/index.js:408`）→ **拒绝水合**，会话看似"丢标题/丢状态"。⇒ 永远不要移动/重命名会话文件或目录。 |
| **7** | ★★ **归档会清 pin，恢复不会还原 pin** | `archiveSession` 在同一写里 `pinnedSessionIds.filter(id => id !== sessionId)`（`:536`）；README:174 "restoring does not restore that pin"。自动归档+恢复后，用户原先的**置顶会丢失**。⇒ 插件 sidecar 里同时记录 `pinnedSessionIds`，恢复后可选 `pinSession` 还原（需用户同意，因为会改顺序）。 |
| **8** | ★★ **`stopActivity:true` 会真的打断用户** | 归档准入检查与写非原子（README:175）。`stopActivity:true` 会 dispatch `workspace/session-stop`，**真的停掉正在跑的 turn / job / subagent / schedule**。自动归档场景下这是破坏性的 → **默认不带 `stopActivity`**，捕获 `WorkspaceActiveSessionError` 后**跳过该 id**，等它空了下一轮再归档。 |
| **9** | ★ **批量归档会让 global 全量重写 N 次** | `archivedSessionIds` 是**整个数组**每次 `global.set` 重写（`:533-537`），且 `enqueueOperation` 全局串行。本机 96 条，一个工作区数十个会话 → 数十次完整重写 + 数十次 `recoverPendingMutation`。⇒ 分批 + 限速；不要在一个 tick 里灌进去。 |
| **10** | ★ **死 id 会累积** | `unarchiveSession` 不查存在性（`:544-547` 注释："an entry whose session is gone still resolves"）→ 会话文件被外部删除后，归档集里留死 id。本机可见 `session-1` 这种历史残留。⇒ 插件可定期用 `sessionPersistence.list()` 的 id 集与 `archivedSessionIds` 求差，但**只报告不清洗**（清洗是官方的事）。 |
| **11** | ★ **`cwd` filter 不走 realpath** | `dsh-session-query` 的 `{kind:'cwd'}` 是 `record.header.cwd` 的**字符串精确比较**（`:754`），而 `ws.path` 是 `fs.realpath` 归一过的 → **同一目录可能不相等**（大小写、尾斜杠、symlink）。用这条路反查前必须自己归一化。 |

### 6.4 版本差异备注（跨版本行为）

plugin-1 在 **trial profile / DSH 0.1.7-rc.2** 上实测到："归档集在 trial（0.1.7-rc.2）**不发布到客户端**：归档成功后宿主注册表已更新，但侧栏行**仍可见**（无「已归档」标记）"，并用官方自身按钮做了对照实验（`.verify/v25-archive-nodes.txt` 关键发现 3）。

本报告基于 **桌面版 0.2.0-rc.2** 的 asar，其代码**确实**实现了发布与隐藏：
- `feed.js:104-108` 会 publish `{type:'archived', archivedSessionIds}`
- `client.js:502-503` `acceptIncrement` 的 `case "archived": accept.replaceArchived(...)`
- `dsh-client-ui-workspace/lib/client.js:357-367` `sessionVisible()` 在 `archivedFilter === 'default'` 时 `return !archived.has(session.id)`

⇒ 桌面版应当**默认隐藏已归档会话**。**但本轮未做 GUI 实测**（按纪律不起服务、不驱动界面），此点标记为**代码层面已证实、运行时未证实**。

---

## 附：本次勘察使用的只读手段

| 手段 | 位置 | 用途 |
|---|---|---|
| `asar.mjs`（既有） | `plugin-2\.recon\asar.mjs` | `--list/--print/--grep/--tree/--extract` |
| `hdr.mjs`（本轮新建） | `plugin-2\.recon\hdr.mjs` | 定位 zstd 帧魔数 `0xFD2FB528`，解出 session 日志**首帧 header 行** |
| `count.mjs`（本轮新建） | `plugin-2\.recon\count.mjs` | 精确统计 `workspace.json` 各字段 |
| `scan.mjs`（本轮新建） | `plugin-2\.recon\scan.mjs` | **全 asar 正则扫描**（11,470 个文本文件）——用来证明 `'missing-dir'` 零消费者、界定 `archiveSession` 全部出现处 |
| 解包产物 | `plugin-2\.recon\extract\<包名>\` | 26 个官方包的 lib 源码，供 ripgrep |

**未做 / 未证实的项**（诚实标注）：
- 未做任何 GUI 运行实测（未起服务、未驱动界面、未删除任何文件夹）
- `CourseSystem` / `NewToLearn` 两个目录**当前是否还在磁盘上**未验证
- `chokidar depth:0` 在 Windows 上对"父目录里某子目录被删"的可靠性——**未证实**
- 桌面版"归档后侧栏真的隐藏"——**代码已证实，运行时未证实**
- `archivedSessionIds` 究竟 96 还是 97（`00` 号报告写 97，本轮两次独立读取均为 96）
