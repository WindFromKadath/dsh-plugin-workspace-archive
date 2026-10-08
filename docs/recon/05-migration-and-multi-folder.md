# 05 · 两个"看起来该做"的能力，为什么本插件做不到

> 记录日期：2026-10-08　采样：本机 DSH `0.2.0-rc.2`（全局安装树只读核对）＋ GitHub / npm 只读检索
> 状态分级沿用本仓库纪律：**✅ 已实测**｜**🟡 契约已核实未实测**｜**⏳ 未验证**｜**❌ 已证伪**
> 本文是**边界记录**，不是待办：两条能力经用户 2026-10-08 决定**暂不做代码**，只把依据留档，避免以后重复调研。

## 0. 结论

| # | 能力 | 官方通道 | 结论 |
|---|---|---|---|
| 1 | 把会话从**一个工作区**迁到**另一个工作区**（例：Rust → DeepSeekHarness） | **不存在** | 🟡 官方没有任何迁移通道；唯一实现方式是**改写会话存储里的 header `cwd`** = 直写 `~/.dsh/sessions/`，与本插件"只走官方 API"的红线冲突；生态已有先占者 |
| 2 | 让**一个工作区**受控访问**多个文件夹**（跨文件夹读写） | **单根，无扩展面** | 🟡 沙盒策略的 `workspaceRoot` 是**单值**；官方 ACP 层明文拒绝 `additionalDirectories`；多根由**第三方插件**补 |

**能做的官方子集（未实施，留作备选）**：第 1 条的"**无项目 → 按 cwd 归位**"——扫"未分组"里的会话，凡 `header.cwd` 与某个已登记工作区路径 realpath 等值，就用 `Workspace.attachSession` 挂回去。纯官方 API、零风险，覆盖"插件没在跑时散掉的会话"；但**不覆盖**跨 cwd 的迁移。

---

## 1. 第 1 条：跨工作区迁移 —— 五条通道逐条排除

| 通道 | 结论 | 源码位置与要点 |
|---|---|---|
| `Workspace.attachSession(sessionId)` | ❌ 跨 cwd 直接抛错 | `dsh-workspace/lib/index.js:111-129`：读会话 header → `realpathNormalize(cwd)` → 必须是目录 → **`cwd !== this.record.path` 即抛**"its cwd resolves to '…'" |
| `Workspace.insertSessionBefore(sessionId, beforeId)` | ❌ 只做**组内排序** | 同文件 `:130-147`：会话**必须已在该工作区成员表里**，否则 `WorkspaceMoveInvalidError`（`:63-70` 定义）。控制器把它转成远端错误 `workspace/move-invalid`（`dsh-api-workspace-controller/lib/types/commands.js:92-101`） |
| 官方客户端拖拽 | ❌ **只能同组拖** | `dsh-client-ui-workspace/lib/client.js:2545-2546`：`sameGroupDrag = drag.accountKey === group.key`，`compatibleTarget = sameGroupDrag && …`；跨组那条 `onDrop`（`:2499-2507`）走的是 `workspaceDrag` = **工作区排序**，不是会话移动 |
| `sessionController.fork` | ❌ fork 落在**源会话所在工作区** | `dsh-api-session-controller/lib/types/commands.js:239` `workspace = await this.forkWorkspace(source.header)`；`:519-531` 的实现是"在注册表里找**成员表包含源会话**的那个工作区"（subagent 来源再沿 lineage 找祖先），**不是**"当前焦点工作区" |
| `sessionController.create({ workspaceId })` | ➖ 只能**新建空的**会话到目标工作区 | 同文件 `:108-134`：`workspaceId` 与 `cwd` 互斥，创建后 `workspace.attachSession(sessionId)`；没有"把已有会话搬进去"的入口 |

**⇒ 唯一实现路径**：改写会话日志 header 的 `cwd`（并搬目录、更新注册表、对齐投影缓存）。
生态先占者 **`birdmanhj/dsh-mv-session`**（★0，2026-09-25 推送）README 写明：只重写 zstd **第 0 帧**的 header（否则开机崩 `first frame is not exactly one header line`）、搬 sessions 目录、改 workspace registry、对齐 projection cache，**由 agent 调一次工具触发**、**必须重启一次 `dsh web`**、需手动删过渡软链接。⇒ 它直写磁盘，且要求停机窗口。

**本插件的红线**（见 [AGENTS.md](../../AGENTS.md) §危险操作边界、[README.md](../../README.md) 限制）：只走 `workspaceRegistry` / `Workspace` 官方 API，**不写** `~/.dsh` 下的官方 `storages/`、`sessions/`。第 1 条的真做法与该红线正面冲突，**不是"加个小工具"**。

官方需求侧证据：GitHub `deepseek-ai/deepseek-harness` Discussion **#3012**《Moving or renaming a project folder makes its session history disappear, with no recovery path》（2026-08-18 创建）—— 需求真实、官方未认领。

---

## 2. 第 2 条：一工作区多文件夹 —— 官方就是单根

| 事实 | 源码位置与要点 |
|---|---|
| 执行策略里的根是**单值** | `dsh-sandbox/lib/types/index.d.ts:27-31`：`SandboxExecutionPolicy { mode; workspaceRoot: string; sessionId? }` |
| 可写根 = 该单值 + 临时目录 | `dsh-sandbox/lib/index.js:166-173`：`workspace-write` → `[...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))]`；`read-only` → `[]` |
| 每轮调用的根来自**会话 cwd** | `dsh-sandbox-policy/lib/index.js:141-148`：`resolve()` 返回 `workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`；`sessionProjections` 只承载 `sandbox/mode`（`:114-120`），**没有"额外根"的投影或配置键** |
| 官方 ACP 层明文拒绝额外目录 | `dsh-acp/lib/index.js:1412`：`additionalDirectories is not supported` |
| 软链/junction 绕不过去 | `dsh-fs-sandbox/lib/index.js:160` 每次写入前**重新规范化目标**并要求落在某个可写根之下（README 亦写明"被替换的符号链接祖先也会被发现"）⇒ 在工作区里放 junction 指向别处的文件夹，写穿它会被拒 |

**生态的做法**：`dsh-workspace-combiner`（`ninglovegithub`）把"可写根"同步进 **`@chaoset/sandbox-extra-roots`**（第三方插件，`winliyou/dsh-plugins`）维护的额外白名单。⇒ 多根**不是官方能力**，是另一个插件补的；要用就得依赖它。

**若仍要做，三条路及代价**：

| 路线 | 代价 |
|---|---|
| 依赖 `@chaoset/sandbox-extra-roots` | 破坏本插件"**零运行时依赖**"的硬约束（见 D009）；对方没装即失效，需做降级与提示 |
| 自己拦截/替换 `sandboxPolicy` 服务 | 侵入**全局**沙盒策略（影响所有会话的所有工具调用），不再是"只动 workspace registry"的旁路插件；风险面从"归档/恢复"扩大到"文件权限" |
| 把工作区登记到**共同父目录** | 不需改沙盒，但粒度变粗（整棵子树可写）；且已有会话的 cwd 是子目录，`attachSession` 校验会全部对不上 ⇒ 必须配合第 1 条的禁区才能迁移 |

---

## 3. 与生态的关系（同日核查）

- 第 1 条：**已有先占者** `birdmanhj/dsh-mv-session`（迁移），另 `dsh_session_folders` / `dsh-session-manager` 提供**手工**"移动到工作区"（对 cwd 已匹配的会话有效，见下）。
- 第 2 条：**已有实现** `@chaoset/sandbox-extra-roots`（+ `dsh-workspace-combiner` 的集成），本插件重做等于**重复造轮子**。
- 本插件当前的差异化（三次调研一致）在"**目录消失触发 + 自持台账 + 只恢复自己的 + 挂回分组且不改归档态**"这条缝，与上述两者不重叠。

## 4. 未覆盖范围

- 以上第 1、2 条结论均为**源码契约级**（🟡），**未在本机实测**："跨 cwd 调 `attachSession` 会抛错""软链写穿会被拒"都是读实现得出的，没有实跑反例。
- 未验证 `@chaoset/sandbox-extra-roots` 的实际可用性与与本机版本的兼容性；未读其源码。
- 未验证 `dsh-mv-session` 在本机的实际行为（只读其 README）。
- 生态家数为 2026-10-08 采样值，会过期。
