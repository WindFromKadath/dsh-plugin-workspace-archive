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

1. header 完整字段与是否有其他 cwd 派生字段；2. ~~`locate()` 是否严格按 `projectKey(cwd)` 目录查找（决定第 4 步是否必需）~~ → **已结案 2026-10-11，结论：严格按，第 4 步（搬目录）必需**。依据：`projectDir(root, cwd) = join(root, projectKey(cwd))`（`dsh-session-persistence-jsonl/lib/index.js:902-905`），`locate(meta)` 取 `logPath(this.root, meta.cwd, meta.id, …)`（`:2416-2420`）⇒ 日志位置**完全由 header 的 cwd 决定**，只改 header 不搬目录 = 官方在新路径下找不到日志；3. projcache 冷读代价实测；4. 是否存在代际迁移摘要（`expectedPrefix.digest`）会被触发（初判只在 v3→v4 迁移路径）；5. `sessions/` 下是否还有别的按 slug 的索引。

### 2.5 风险与缓解

停机要求（预检阻断）｜写坏日志（**只改第 0 帧** + 原子替换 + 写前按 boot 断言自检 + 备份）｜跨盘（copy 回退）｜官方改格式（版本闸门：只允许已知 `formatVersion`，`logName` 由代际推导）｜**毁掉插件身份**（T1 建议独立成工具/仓库，见下）。

### 2.6 落点建议（待定）

T1 的真做法要直写 `sessions/` 与（可选）`storages/`，与本插件"只走官方 API + 零依赖"的两条立身之本冲突。建议 T1 做成**独立工具**（可复用本仓库的 `test/register.mjs` 与真机装置），本插件只保留 T0。

## 3. 共用引擎：B（会话跨组迁移）与 C（工作区改名重绑定）

> 2026-10-11 用户选中 **C（工作区改名重绑定）** 作为下一个功能，并指出「**C 其实是 B 的基础**」。核对后成立：两者共用**同一个离线改写引擎**，差额只在"登记"那一层。

| 步骤 | B：会话跨组迁移 | C：工作区改名重绑定 |
|---|---|---|
| 预检（DSH 必须完全退出）+ 备份 + 回滚 | 需要 | **同一个** |
| 只改第 0 帧 header 的 `cwd` | 需要 | **同一个** |
| 把会话日志目录搬到新 `projectKey`（§2.4 #2 已结案：必需） | 需要 | **同一个** |
| projcache 处理（5 字段 identity 或删记录） | 需要 | **同一个** |
| 意图 sidecar → 启动后官方 `attachSession` | 需要 | **同一个** |
| 目标工作区从哪来 | 从已有列表里挑 | 用户给新路径 |
| **改工作区登记（delete 旧 + create 新）** | ❌ 不需要 | ✅ **C 独有** |
| **搬本插件自己的台账条目**（按路径为键） | ❌ 不需要 | ✅ **C 独有** |

**⇒ 引擎只写一次，B 和 C 都是它的前端。**
**推荐顺序：先把引擎在 B 上跑通，再加 C 的登记层。** 理由是爆炸半径 —— B 不动登记，最坏情况只是"会话没搬过去"；C 要 `delete` 登记，最坏情况是"工作区没了"。引擎在 B 上验过之后，C 只剩两件可预测的事。

### 3.1 C 独有的两层（2026-10-11，源码级新事实）

1. **工作区 `path` 不可变，且官方没有改路径的通道。** `WorkspaceRegistry` 的全部写接口是 `create(path, title?)` / `delete(id)` / `resolveByPath(path)`（`dsh-workspace/lib/types/index.d.ts:145,180,264`）；`Workspace` 实体只有 `setTitle` / `attachSession` / `insertSessionBefore` / `detachSession`（`types.d.ts:69-127`，`path` 是只读 getter）⇒ 改路径**只能 `delete(旧) + create(新)`，得到新 id**。
   - 这**不算绕开官方**：`types.d.ts:10-11` 明说 workspaceId *"A generated uuid, **never the path**: path normalization rewrites paths, and a reference anchor must stay stable."* ⇒ id 本来就不该与路径绑定。
   - 注意 `create` 的路径会经 `fs.realpath` 规范化（`paths.d.ts:21-33`），且"同一路径重复 create 返回同一条"（`index.d.ts:136-140`）⇒ 幂等，可重入。
2. **成员表是由 header cwd 投影出来的，且每次写操作都会 prune。** `entity.d.ts:22-25`：实体只见 "the canonical session-path index **backing the `sessionIds` projection**"；`mutate`（`:74-78`）*"pruning candidates that no longer pass the **id-plus-canonical-cwd membership check**"*。
   - ⇒ **重绑定必须原子**：header 改了而登记没改（或反之）时，只要 DSH 在这中间启动并发生**任意一次** workspace 写，成员就会被永久 prune。这正是本插件台账存在的理由，也是 C 必须"**停机窗口内一次做完**"的根据。

### 3.2 ⚠️ 实测修正（2026-10-11，真机阶段 8；**同日已修**，见 F023）：改名一度不会立刻触发归档

我原先写的"改文件夹名后本插件会把那批会话归档"**只在别的事件或兜底轮询把插件叫醒之后才成立**。真机复现（`.verify/real-machine.mjs` 阶段 8，13 条断言，**51/51 通过**）给出的事实：

| 事实 | 断言 |
|---|---|
| 改名后官方 `status()` = `missing-dir`，而登记仍停在旧路径 | 2 |
| 官方**不会**跟随改名：注册表里没有新路径的记录 | 3 |
| 旧登记与成员表此刻仍在（尚未被 prune） | 4 |
| 台账**已经记过**这条工作区 ⇒ "没归档"不是因为没被跟踪 | 5 |
| **但台账 `missingSince` 仍是 `null` ⇒ 插件根本没被叫醒** | 6 |
| 因此改名后那段窗口内**没有**归档 | 7 |
| 会话日志仍在**旧** `projectKey` 目录下，不会自己跟着目录走 | 8 |
| 把新路径当新工作区添加 ⇒ **新 id、0 成员**，旧记录不会被复用 | 9 |
| 一旦被 `domain/changed` 叫醒，插件**立刻**归档 ⇒ 缺的只是"醒来" | 10 |
| 旧会话 `attachSession` 到新工作区**被拒**：*"its cwd …. does not resolve, so it cannot be validated"* | 11 |

**根因**（`src/index.js:452-455`）：watcher 回调按**被跟踪目录的旧 basename 集合**过滤事件 ——

```js
const changed = typeof filename === 'string' ? filename.toLowerCase() : undefined
if (changed === undefined || names.has(changed)) notifyChange()
```

改名时事件里的 `filename` 是**新名字**，不在 `names` 里 ⇒ 事件被丢弃。删目录走的是同一条链路、但 `filename` 恰好就是旧名字，所以**只有改名会漏**（`rmtree` 那种删法反而正常）。

**⇒ 对 C 的影响**：改名之后"会话有没有被归档"**一度是不确定的**（取决于这段期间有没有别的注册表事件把插件叫醒、或有没有等满兜底轮询）⇒ C 的输入状态不确定。

**这一条已按建议先修掉（F023，2026-10-11）**，所以现在可以这样假定：

| 改名发生时 | 该组会话的状态 |
|---|---|
| **DSH 在运行** | **被自动归档**（进台账 `archivedSessionIds`，与"删目录"同一条链路、同一窗口） |
| **DSH 已停机** | **不归档**（插件根本没看见目录消失）—— C 也推荐在这个窗口做 |

⇒ C 仍要**按台账的实际内容**决定怎么处理，但前提是明确的（不再是"随机取决于有没有别的事件"）；而且两种输入都**能稳定复现**（前者走真机装置，后者天然如此）。

### 3.3 C 必须处理的层（修正版）

1. **登记重绑**：`delete(旧)` + `create(新)` ⇒ 新 id（§3.1 已证 `path` 不可变）。`create` 幂等，可重入。
2. **台账键迁移**：本插件台账按**路径**为键。重绑后条目仍挂在旧路径键下 ⇒ `/restore-workspace <新路径>` 查不到、且旧键永不再被 reconcile 触及。必须把条目从旧键迁到新键。
3. **归档态保持，且**⚠️ **不能无脑 `unarchive`**：那会把**用户自己手动归档**的一起放出来。必须沿用 D015 的分账 —— `archivedSessionIds`（自动）与 `manualArchivedSessionIds`（手动）各自保持原样，只搬键。
4. **验收必须包含**：「改名 + 重绑之后，用户的归档态与归档来源（手动/自动）全部保持不变」—— 否则就是把 F020 刚守住的那条线又踩了。

---

> 下面这一节原先写在 README 里，2026-10-13 移到这里 —— npm 包只发布**已实现的本体**，探索内容留在仓库。

## 离线迁移工具（**探索性原型** —— 机制已验证，但**不是面向用户的功能**）

> ⚠️ **它现在不是一个用户可用的功能。** 迁移一条会话要求：**完全退出 DSH → 在外部终端跑命令 → 重启 DSH。**
>
> 「迁移数据必须先关掉应用」本身就不合逻辑。**根因在上游，不在本工具**：官方把会话 header 缓存在内存里，而**没有任何公开入口能重建它**（实测见 `AGENTS.md`）。所以这一块的定位是**探索与验证** —— 机制层可靠，用户层不可用。任务表里对应的两行（B / C）都标为 `blocked`，**不计为已交付**。

跨工作区迁移 / 工作区改名重绑定都需要**离线改写会话日志的 header** —— 官方没有这个通道。所以它做成**独立 CLI**，不进插件的运行时代码（插件仍然「只走官方 API」+「零运行时依赖」）。

```bash
# ⓿ 列出会话（只读）：显示侧栏标题，并按官方 blank 位隐藏空白会话
node bin/dsh-session-migrate.mjs list [--cwd <路径>] [--all]

# ① 只读预演：扫描 + 预检 + 打印计划，一个字都不写
node bin/dsh-session-migrate.mjs plan --session <id> --to <目标工作区>    # 迁**单条对话**
node bin/dsh-session-migrate.mjs plan --from <源 cwd> --to <目标工作区>   # 迁一整组

# ② 执行：备份 → 只改第 0 帧 → 搬目录 → 逐条自检 → 源改名成墓碑，并写下迁移意图
node bin/dsh-session-migrate.mjs apply --session <id> --to <目标工作区> \
  --backup <备份目录> --i-have-stopped-dsh

# ③ 重启 DSH：插件读到意图，用**官方** attachSession 把会话挂到目标工作区
# ④ 回滚：源目录放回、目标目录删除（迁移意图一并清掉）
node bin/dsh-session-migrate.mjs rollback --backup <备份目录>
```

`--from` **可以省略**：只给一个 `--session` 时，源 cwd 由**那条会话自己的 header** 决定 —— 这就是「手动迁移单个对话」的入口，你不必先知道它属于哪个工作区。

退出码：`0` 成功 / `2` 被拒绝或被阻塞 / `1` 用法或内部错误。

### 两个硬前提（都实测过）

**① 目标必须已经是 DSH 里登记过的工作区。** 离线层只改 cwd + 搬目录；把会话挂进成员表要靠插件的官方 `attachSession`，而它要求目标路径已经登记。`plan` 会读官方 `storages/workspace.json`（只读）核对，不满足就**直接阻塞**并给出指引 —— 免得白跑一趟，结果是「会话不见了」。

**② 必须先完全退出 DSH，而且迁移要重启后才生效。** 官方 registry 有 **header 内存缓存**（`dsh-workspace/lib/index.js:911-923`，bootstrap 时灌满），活着的进程会一直读到**旧的** cwd，`attachSession` 报 *"its cwd resolves to &lt;旧路径&gt;"*。实测：**没有任何公开接口能刷新它**（证据见 `AGENTS.md`）。所以流程只能是「关机 → apply → 开机」。

### 写入闸门与安全顺序

两道闸门缺一不可：显式 `--i-have-stopped-dsh`，以及必填的 `--backup`（**没有默认值**，避免悄悄写到意料之外的地方）。工具不替你判断 DSH 是否在跑 —— Windows 上没有可靠的检测方式，与其假装检查，不如要求显式声明；但下面第 ⑤ 步会对**真正危险的那种情形**兜底。

```
① 备份      任何改动之前：整份会话目录 + manifest.json + plan.json
② 改写      只改第 0 帧
③ 写新      临时文件 + 原子 rename
④ 自检      目标 header 的 cwd 正确 / 第 0 帧之后的字节与源逐字节相同 / 事件行逐字相同
⑤ 改名      把源**改名成墓碑**（不是直接删）
⑥ 确认      静默窗口后：没人写 ⇒ 删墓碑；有人在写 ⇒ 保留墓碑并**如实报错**
```

**第 ⑤ 步为什么是「改名」而不是「删除」**：实测过 —— 若那条会话**正被打开**，删掉目录之后写入方**仍然写入成功、也不报错**，数据落到一个没有目录项的文件上，**静默丢失**。改名就不同：句柄跟着走到墓碑上，数据**留在墓碑里**，「还在被写」于是**可探测**。而且还有一层：源被占用时改名直接抛 `EPERM` ⇒ 工具**干净中止**（`source-locked`），并把刚写出的目标撤掉，源与目标**都复原**。

⇒ 任何一步失败，**源都还在**；宁可不做，也不丢数据。

### 机制层已经能（**不等于用户层可用**）

- 按 `projectKey(cwd)` 定位一个工作区的会话；按**会话 id** 直接定位（`encodeSegment(id)`，几次 `stat`，不扫日志）
- 列出会话并显示**侧栏标题**（只读官方投影缓存），用**官方 `blank` 位**隐藏空白会话
- 逐条复核 header（cwd 必须相符、文件名代际必须与 header 版本一致）→ 只改第 0 帧 → 三重自检
- 任何不确定都拒绝：目标目录不存在、目标不是已登记工作区、有残尾、目标会话目录已存在、会话找不到……
- 迁移意图 → 插件用**官方** `attachSession` / `detachSession` 收尾；**归档态不用补偿**（归档集合是会话 id 的全局集合，与 cwd 无关，原本归档的在新组里仍然归档）
- 完整回滚，逐字节复原

### 还没做

- **projcache 迁移**：改 cwd 后大会话首次冷读可能变慢。正确性不受影响（官方对缓存记录身份不匹配是 fail-soft），只是没实测过代价。
- **不重启就实时生效**：做不到，原因见上面第 ② 条 —— 卡在官方缺少公开的重建索引入口，不是本工具能补的。
- **面向用户的操作方式**：没有。目前只有 CLI + 停机窗口，这是**上游能力缺口**的直接后果，不是本工具的设计取舍。
