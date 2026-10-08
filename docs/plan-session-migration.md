# 会话迁移（功能 1）· 计划与执行记录

> 建立 2026-10-08。T0 已实现并真机验证；T1 已获用户放行（允许离线直写会话 header），实现待开工。
> 边界背景与官方通道排除依据见 [docs/recon/05-migration-and-multi-folder.md](recon/05-migration-and-multi-folder.md)。

## 0. 两层拆分

| 层 | 覆盖 | 是否破"只走官方 API" | 状态 |
|---|---|---|---|
| **T0 归位** | 「无项目」且 `header.cwd` **精确等于**某已登记工作区路径 | ❌ 不破（`sessionPersistence.list()` 只读 + `Workspace.attachSession`） | ✅ **已实现**（2026-10-08，真机 27/27、单元 48/48） |
| **T1 真迁移** | 跨组（例：Rust → DeepSeekHarness）、未分组但 cwd 指向别处 | ✅ **破**：必须离线改写会话 header 的 `cwd` | ⏳ 已放行，待开工 |

## 1. T0 归位（已实现）

**为什么需要**：官方 registry 只在**第一次启动**时按 `header.cwd` 归组（bootstrap 一次性、写 initialized 标记后永不再跑）。此后"会话在「无项目」里、而它的 cwd 明明就是某个已登记工作区的路径"没有任何官方通道能自愈。

**实现**（`src/adopt.js` + `src/index.js` 接线）：

- 数据源全部**官方只读**：`ctx.sessionPersistence.list()` → 每个已存会话的 `header`（含 `cwd`）；`ctx.workspaceRegistry.list()` → 工作区路径与成员表。**不读 `sessions/` 文件、不解 zstd**。
- 判据（刻意收紧）：① 会话**不在任何**工作区成员表里；② `realpath(cwd)` 与工作区路径**精确相等**（不做前缀/父目录/子目录匹配）；③ `cwd` 解析不了（目录已不在）直接跳过；④ 按 `createdAt` 升序下发（`attachSession` 是前插 → 结果才是官方惯例的"新的在前"）。
- 写入只调官方 `Workspace.attachSession`；**绝不**碰 `archivedSessionIds`；失败逐条记日志。
- 配置：`adoptUngrouped`（默认 **true**）、`adoptDelayMs`（默认 5000，避开官方 bootstrap）、`dryRun` 为真时只记日志。
- 与归档/恢复的关系：归位后的会话会进入下一轮健康台账快照，从而**自动获得**「目录消失→归档→回归→挂回」的保护。

**验证证据**：

- 单元：`tests/adopt.test.mjs` 7 项（含"前缀/父目录/子目录都不算命中"、"dryRun 不调 attach"、"cwd 解析失败跳过"、"单条失败不影响其余"）。
- 真机：`.verify/real-machine.mjs` 阶段 1b + 阶段 6（**先红后绿**：把 `adoptUngrouped: false` 临时写进 `.verify/rm/cordis.yml` 跑出 `FAIL T0 归位…` 26/27，还原配置后 **27/27**）。
- 反例断言：cwd 没有对应工作区的会话**不**被塞进任何组；只挂一次不重复；不新增工作区记录。

**已知边界**：只处理"cwd 已经等于工作区路径"的情形；跨 cwd 的迁移属于 T1。

## 2. T1 真迁移（计划）

### 2.1 核心思路：把"必须离线的文件改写"和"必须官方的登记"分开

**阶段 A —— 离线工具（DSH 必须完全退出）**

1. 预检阻断：确认 DSH 未运行；备份受影响会话目录 + `storages/workspace.json` + `session_projcache` 记录 → 备份落**仓库外**。
2. 定位：`sessions/<projectKey(srcCwd)>/<id>/<logName>`，其中 **`logName` 必须按代际推导**（`sessionFormatLogFilename(version)`：代际 0 = `session.jsonl`，vN = `session.vN.jsonl`，本机 0.2.0-rc.2 是 **`session.v4.jsonl.zstd`**）。
3. 改写：只解码**第 0 帧** → 改 header JSON 的 `cwd` → `zlib.zstdCompress(..., {params:{[ZSTD_c_checksumFlag]:1}})` 重压 → **其余帧字节原样拼接** → 临时文件 + `rename` 原子替换。
4. 搬迁目录：`<projectKey(srcCwd)>/<id>` → `<projectKey(dstCwd)>/<id>`（**必须有跨盘 copy 回退**，不能只 `rename`）。
5. 写意图 sidecar：`$DSH_HOME/workspace-archive/pending-migrations.json`。

**阶段 B —— 在线（插件，启动后一次）**：读意图 → 官方 `Workspace.attachSession(id)`；若源会话原本归档，再用官方 `archiveSession(id)` 在新组**保持归档**（**不直写** `workspace.json`）。

**阶段 C —— 校验与回滚**：校验出现在目标组、历史事件数不变、旧组不再列出、归档态一致；`--rollback <备份>` 还原。

### 2.2 现成实现评估（T1-0，2026-10-08，源码级）

生态先占者 **`birdmanhj/dsh-mv-session`**（★0，MIT，npm 0.1.2，最后代码提交 2026-08-28）**不能直接用**，两个硬阻断：

| 阻断 | 事实 |
|---|---|
| **E1 文件名代际不匹配** | 它 5 处硬编码 `session.jsonl.zstd`（代际 0）；本机 `sessionFormatCatalog.currentVersion = 4`，`$DSH_HOME/sessions` 下 **22/22 是 `session.v4.jsonl.zstd`** ⇒ 它的 `preflightLogs()` 在任何改动前 fail-closed，**在本机什么都不做** |
| **E2 语义不匹配** | 它是"**整个工作区**改名迁移"（`move_dir` 工作区目录 + 留过渡 symlink + `merge_workspace_record` **删掉源记录**），不是"单个会话挂进现有工作区" |

**要借鉴的**（`lib/migrate_session.js` 的纯函数，零依赖，可直接搬）：`scanZstdFrames()`（不解压定位帧界 + 残尾）、`rewriteHeaderCwd()`（只换第 0 帧 + 塌缩帧修复）、`verifyMigratedLog()` / `isExactlyOneHeaderLine()`（与官方 `assertZstdHeaderFrame` 同款断言）、`preflightLogs()` 的"先全量验证、失败零改动"、`createZstd()` 的 **native 分支**（`{params:{[ZSTD_c_checksumFlag]:1}}`，与官方完全一致；**不要**抄它的 `@mongodb-js/zstd`/CLI 回退，那两个不带 checksum）、`projectKey()`/`encodeSegment()`（已验证与官方逐字节一致）。

**不要借鉴**：整工作区语义、`buildPlan`/`executePlan` 的 registry 直写（我们改用官方 `attachSession`）、`--fix-projcache` 的 2 字段 identity、`detectLiveDsh()`（Windows 上 `lsof`/`pgrep` 都不存在 → 守卫静默失效）、`cleanup_empty_sessions`（会误删/留悬垂 id）。

**它踩过而我们能继承的教训**：① 整份解压重压会让第 0 帧塌缩 → `dsh web` 启动崩（`first frame is not exactly one header line`，2026-08-24）⇒ 只能换第 0 帧；② projcache 在活进程窗口被写回覆盖 + 大会话冷读全量重放导致 `signal timed out`（2026-08-26 事故）⇒ 改 header 后必须处理/放弃该会话的缓存记录，且要在停机窗口做。

### 2.3 projcache 的正确处理（新增约束）

官方 `dsh-session-projection-cache` 的 `checkpointIdentity` 含 `{formatVersion, createdAt, cwd, isSeeded, inheritedEventCount}`，`currentLifecycleMatches` 要求 `stored.formatVersion === expected.formatVersion`，**缺 `formatVersion` 的记录永远不匹配**（`lib/index.js:49`、`:399`）。会话 cwd 一变，旧记录身份即不匹配 ⇒ 官方行为是"陈旧记录读作不存在、由消费方从日志重折"：

- **正确性**：无需处理（fail-soft）。
- **性能**：大会话首次冷读会全量重放，可能触发超时。因此 T1 要么按 **5 字段 identity** 同步更新该会话的缓存记录，要么**删掉该记录**让官方重折；两者都属于 `storages/` 直写，必须在**停机窗口**内做。
- 待实测：本机一条真实会话改 cwd 后的冷读代价（🟡 未验证）。

### 2.4 待勘察（不靠猜）

1. header 完整字段与是否有其他 cwd 派生字段；2. `locate()` 是否严格按 `projectKey(cwd)` 目录查找（决定第 4 步是否必需）；3. projcache 冷读代价实测；4. 是否存在代际迁移摘要（`expectedPrefix.digest`）会被触发（初判只在 v3→v4 迁移路径）；5. `sessions/` 下是否还有别的按 slug 的索引。

### 2.5 风险与缓解

停机要求（预检阻断）｜写坏日志（**只改第 0 帧** + 原子替换 + 写前按 boot 断言自检 + 备份）｜跨盘（copy 回退）｜官方改格式（版本闸门：只允许已知 `formatVersion`，`logName` 由代际推导）｜**毁掉插件身份**（T1 建议独立成工具/仓库，见下）。

### 2.6 落点建议（待定）

T1 的真做法要直写 `sessions/` 与（可选）`storages/`，与本插件"只走官方 API + 零依赖"的两条立身之本冲突。建议 T1 做成**独立工具**（可复用本仓库的 `test/register.mjs` 与真机装置），本插件只保留 T0。
