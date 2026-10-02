# 00 · Lead 亲自核实的硬事实（先于子报告）

> 环境锚点：DSH 桌面版 **0.2.0-rc.2**（`dshBuildCommit 04f392c9ddd144fa426da2045178797da6db6c11`），官方源码在 `<app>\resources\app.asar`，asar 内根为 `dsh/`，全部官方包位于 `/dsh/node_modules/@deepseek-ai/*`（约 250 个）。
> 本机 profile：`$env:DSH_HOME\profiles\desktop\cordis.yml`（插件装载清单）；数据：`~/.dsh/sessions/<路径 slug>/`、`~/.dsh/storages/`。
> 只读工具：`node plugin-2\.recon\asar.mjs --list|--print|--grep|--tree|--extract <asar> <asar内路径> [extra]`。

---

## 一、需求①（总结对话 → 对话自己命名）的现状

### 1.1 官方已装载的标题机制

`cordis.yml` 里与命名相关的**已启用**插件只有三行：

| id | 包 | config |
|---|---|---|
| `session-title` | `@deepseek-ai/dsh-session-title` | `fallbackMaxWords: 5` / `fallbackMaxBytes: 40` / `maxTitleBytes: 80` |
| `session-title-llm` | `@deepseek-ai/dsh-session-title-first-prompt-llm` | `targetWords: 5` / `targetCjkCharacters: 10` / `maxInputBytes: 4096` / `maxOutputTokens: 64` / `timeoutMs: 60000` |
| （服务实现） | `@deepseek-ai/dsh-session-title-llm` | 被上一个提供方内部使用，未单独装行 |

`dsh-session-title` 的官方契约（`/dsh/node_modules/@deepseek-ai/dsh-session-title/README.zh.md`）明确：

- 标题只有三个来源，**最新者胜出**：内置确定性回退（取第一条合格用户消息开头若干词）、已注册**一个**提供方、显式 `rename()`。
- **只有人类 `user/message` 事件里的文本块合格**；"用户来源的最新标题会**钉住**会话——后续用户消息不再安排自动修订，显式 `refresh()` 仍是有意的解钉手段。"
- 标题是"持久的、仅写入日志的状态"：每个已接受修订是一个 **`session/title` 事件**，`foldSessionTitle()` 取最新；**绝不进入模型输入**。
- 服务要求 `ctx.sessionProjections`，注册两个投影单元：客户端可见的 **`title`**、host 专用 **`titleInput`**（折叠第一条与最新一条合格消息及其计数）。
- 扩展点：`ctx.sessionTitle.register(provider)`（**第二次注册立即抛错 → 至多一个提供方**）；`refresh(session)` 显式重跑提供方。
- 已知限制原文："**没有标题删除、搜索或列表索引**——不经显式 `refresh` 就解钉回自动标题、搜索与列表索引不属于此服务。"
- README 里提到两个随附提供方：**首消息** 与 **全消息**（`../session-title-all-prompts-llm/README.zh.md`）。

### 1.2 本机**没有**装"全消息"提供方（关键发现）

- 对 asar 头部 JSON 全文检索 `all-prompts` → **0 命中**；`first-prompt` → 1 命中。即本机构建里**只有** `dsh-session-title-first-prompt-llm`。
- 但 `@deepseek-ai/dsh-session-title-all-prompts-llm` 在 npm 上**真实存在且公开**：描述 "All-user-messages LLM provider plugin for DeepSeek Harness session titles"，最新 `0.2.0-rc.2`，仓库 `deepseek-ai/deepseek-harness`，`directory: packages/session/session-title-all-prompts-llm`（`https://registry.npmjs.org/@deepseek-ai/dsh-session-title-all-prompts-llm`）。
- 结论：官方**上游**提供了"按**全部用户消息**生成标题"的提供方，但**本机未安装**；而且它仍然只看 **user 消息**，不看助手回答，因此严格意义上仍不是"总结整段对话"。

### 1.3 本机实证：当前对话的标题就是"首条消息按字节截断"

读 `~/.dsh/storages/session_projcache/sessions/session-eef9c4ef-7563-40b4-bc4c-95b997a00bbc.json`（本会话）：

```json
"title":      { "ver": 1, "seq": 217, "val": "Chat，搜索当前的DSH中的相关插" },
"titleInput": { "ver": 3, "seq": 217, "val": {
    "first": { "seq": 8, "text": "Chat，搜索当前的DSH中的相关插件\n1、通过总结对话……" },
    "count": 1, "lastSeq": 8 } }
```

即真实结果是 `fallbackMaxBytes: 40` 的**确定性截断**（"相关插件"被切成"相关插"），不是模型总结。`titleInput` 只记 `first/last/count`，不保留可总结的完整对话。

### 1.4 客户端侧已有入口

`dsh-client-ui-workspace`（README.zh/en）：
- Session 行 **Rename** 对话框预填当前显示标题；"确认未修改的标题是有意允许的——这正是把当前自动标题**钉住**、不再被重新生成覆盖的手势"；双击标题也打开 Rename；Fork 会"**递增继承的持久化标题**"。
- Session 行菜单/悬停按钮是槽位列表 `sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`（本站已注册 `rename` 200 等）；插件 action 按 `order` 落位。
- **没有**"重新生成标题"的 UI 入口（`refresh()` 只有服务 API）。

⇒ **需求①缺口**：缺一个"读整段对话（含助手回答）→ 让 LLM 总结 → 写回标题"的提供方或轮次后处理器；官方位子只有一个 `ctx.sessionTitle.register(provider)`，且被 `first-prompt` 占着；本机也没有 all-prompts。**核心能力（写标题、刷新、投影、UI 重命名）全部现成，缺的只是"用整段对话做输入"的策略与触发时机。**

---

## 二、需求②（工作区消失→归档；回来→恢复）的现状

### 2.1 官方**已经有**"会话归档"这一等公民概念

`dsh-workspace`（`/dsh/node_modules/@deepseek-ai/dsh-workspace/README.zh.md` + `lib/index.js`）打开 storage 领域 **`workspace` v2**：

- 全局状态：`workspaceIds`（显示顺序）、**`archivedSessionIds`**、**`pinnedSessionIds`**、可选 `defaultWorkspaceId`、可选 `pendingMutation`。
- 表 `workspaces`: `{ [workspaceId]: { path, title, sessionIds[], createdAt, updatedAt } }`。
- 服务 API（`WorkspaceRegistry`）：`create / list / rename / delete / insertBefore`、**`archiveSession(sessionId, { stopActivity })`**、**`unarchiveSession(sessionId)`**、`pinSession / unpinSession`。
- 归档准入接缝：宿主事件 **`workspace/session-activity`（waterfall）** 与 **`workspace/session-stop`（parallel）**；有活动且未传 `stopActivity` 时抛 `WorkspaceActiveSessionError`。随附提供方：Agent 注册表（运行中回合）、job 注册表、Subagent runtime、Schedule 插件。
- **`Workspace.status()` 已经返回 `ok | missing-dir`**（`lib/index.js:156`、`lib/types/entity.js:116`：`stat(record.path)).isDirectory() ? 'ok' : 'missing-dir'`）。
- 成员资格规则原文："会话加入它运行目录所在的项目……**目录无法校验的会话——没有记录目录，或目录被移动、删除——无法加入，保持 Ungrouped**。"

本机实证 `~/.dsh/storages/workspace.json`：
- `global.workspaceIds` 只有 3 个（`...AuD...`、plugin-1、plugin-2），`global.archivedSessionIds` 已有 **96 条**（Lead 复核：`workspaceIds=3`、`archived=96`、`pinned=0`、`tables.workspaces=3`）。
- `tables.workspaces` 每个工作区带 `path/title/sessionIds/createdAt/updatedAt`。
- `~/.dsh/sessions/` 下却存在 **5 个**目录，其中 `--<other-project-slug>--`、`--<other-project-slug>--` **不在注册表里** → 工作区记录被移除后，**磁盘会话目录原样留着，无人归档、无人恢复**。

### 2.2 官方**明确不做**我们要的自动联动（这就是缺口，官方自己写进了限制）

`dsh-workspace/README.zh.md` 已知限制原文：

- "**移除绝不删除数据**——移除项目会保留其文件夹、文件与会话历史；这些会话变成 **Ungrouped**，而会话删除与文件夹移除是彼此独立且尚未提供的功能。"
- "**外部变更延迟可见**——如果另一进程删除或损坏目录，项目只能在下次刷新或重启后反映出来。"
- "**重新添加目录从空开始**——移除后再次添加同一目录会创建**空会话列表的新项目；旧会话不会自动回来**。"

⇒ 需求②的"**文件夹消失 → 自动归档**"和"**文件夹回来 → 自动恢复**"两条，官方**都不做**；官方只提供零件（`status()` 的 `missing-dir`、`archiveSession/unarchiveSession`、`archivedSessionIds`）。

### 2.3 可用的挂点（已核实）

**Host 侧**（`dsh-api-workspace-controller/README.zh.md` + `lib/typert.host.js` 注册表）：
- 一元 RPC：`workspace/create`、`workspace/delete`、`workspace/rename`、`workspace/insertBefore`、`workspace/insertSessionBefore`、`workspace/archiveSession`、`workspace/unarchiveSession`、`workspace/pinSession`、`workspace/unpinSession`、`workspace/initializeDefault`。
- 流：`workspace/follow` → 先完整 baseline，再 `upsert / remove / order / archived / pinned` 增量；重连换一代 baseline。
- 客户端模型：`ClientWorkspaceModel` + `createWorkspaceStateStream()`。
- 错误码：`workspace/session-active`（`details` 按族列出 `turn/subagent/job/schedule`）、`workspace/not-found`、`workspace/invalid-path`、`workspace/name-conflict`、`workspace/move-invalid`。

**UI 侧**（`dsh-client-ui-workspace`）：
- 归档已有完整交互：菜单"**归档会话 / 取消归档**"、视图三态筛选 `隐藏已归档（默认）/ 全部对话（显示已归档）/ 仅已归档`、已归档行灰显并提示"已归档对话暂时无法查看，请取消归档后查看"、归档成功 toast 带 undo 与"筛选已归档会话"。
- 运行中会话归档会先弹"**停止并归档此会话？**"。
- 插件席位：`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`、`sidebar.session.row.leading`、`sidebar.session.row.hover`。
- 明确限制："**No Session deletion** — sessions can be archived but never deleted"；"Workspace registration deletion does not delete Sessions"。

⇒ **需求②缺口**：缺一个"观察工作区目录存在性 → 对 `missing-dir` 的工作区批量 `archiveSession` → 目录回来时批量 `unarchiveSession`"的策略插件。难点已定位：(a) 没有"目录消失"事件，只能靠 `status()`（每次读时算）或自己 `fs.stat`；(b) `archiveSession` 对运行中会话会拒绝，需要 `stopActivity: true` 或跳过；(c) 重新添加目录会**新建空项目**（新 `workspaceId`），所以"恢复"必须靠**路径→旧会话 id 的记忆**，而不是靠注册表身份；(d) 归档集合是**全局 id 数组**，与工作区成员关系解耦，正好适合"工作区级批量操作"。

---

### 2.4 磁盘布局与会话头（已核实，恢复策略的落点）

`dsh-session-persistence-jsonl`（`README.zh.md` + `lib/index.js`）：

- 目录 = `<root>/--<normalized-cwd>--/<encoded-id>/session.v4.jsonl.zstd`；`projectKey(cwd)` 把路径分隔符/盘符分隔符换成 `-`，再包成 `--…--`，最多 251 字符（对应本机 `--<repo-slug>--`）。无 cwd 的会话落在 `_no-cwd/`。
- 会话头（header）字段含 **`cwd`（必须是绝对路径）**、`id`、`createdAt`、`delegationDepth`、`isSeeded`（`lib/index.js` 的 header 校验器）。
- **`stat(id)` 与 `list()` 只读最高 generation 的 header，不读事件行**（"so snapshots carry … without reading event rows"）→ 一个"按目录找回旧会话"的插件可以低成本枚举全部历史会话的 `id + cwd + createdAt`。

## 三、检索通道（"在 DSH 里搜插件"该怎么做）

- 本机运行时清单 = `$env:DSH_HOME\profiles\desktop\cordis.yml`（+ `cordis.patch.yml` 覆盖层）；`dsh-host-plugin-inventory` / `ui-settings-plugin-inventory` 只读展示 Loader 实际装载状态。
- 官方管理/安装通道 = `@deepseek-ai/dsh-plugin-manager`：**npm registry 优先**（`registry` → `fallbackRegistries` 默认 `https://registry.npmmirror.com/`，可用 `dsh-plugin-manager/registry` 导出的 `OFFICIAL_NPM_REGISTRY` / `NPMMIRROR_REGISTRY`），也支持 git / tarball / 本地路径；`inspect(spec)` 用 `pnpm view` 预检；`dsh plugin` CLI 同源。
- 生态规模：npm 搜索 `dsh-plugin` 命中 **282,181** 项，已有多个社区"插件市场/检索"插件（`dsh-plugin`、`dsh-find-plugin`、`dsh-plugin-marketplace`、`dsh-plugin-shop-catalog`、`awesome-dsh-plugin-feed`、`dsh-plugin-install` 等）。
