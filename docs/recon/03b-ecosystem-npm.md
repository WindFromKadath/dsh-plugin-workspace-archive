# 03b · 生态检索（npm registry / GitHub）

- 检索时间：2026-10-02（Asia/Shanghai）
- 检索方式：npm registry 搜索 API `https://registry.npmjs.org/-/v1/search?text=<kw>&size=20` + npm packument（含 `readme` 字段）+ GitHub API / 仓库页
- 判定范围：仅 ① 按对话内容自动命名；② 工作区文件夹被删除后自动归档其中会话、文件夹回归后自动恢复
- 纪律：未安装任何包、未 clone、未起服务；下载量为搜索 JSON 中的 `downloads.monthly` 原值；取不到的一律写「未找到」，不编造

---

## 一、结论先行

1. **需求 ① 已经被生态充分覆盖，不是空白。** 至少有 3 个第三方实现直接做「用模型总结对话来命名」，其中 `dsh-session-title-pattern` 明确是「对**整段对话**总结」并按 N 条重算，`dsh-titlecraft` 在回合结束时做语义精修并在原生重命名弹窗里加「AI 生成摘要」。加上官方的 `@deepseek-ai/dsh-session-title-all-prompts-llm`（按所有用户消息生成），**再做 ① 属于重复造轮子**，除非要在「自动 rename 的触发时机 / 命名语言 / 模板」上做差异化。
2. **需求 ② 没有被覆盖，是真空白。** 生态里有大量「归档会话 / 恢复会话 / 自动归档」插件，但它们**没有一个**以「工作区目录消失」为触发条件，也**没有一个**在目录回来后自动恢复。
3. **最接近 ② 的是三个各占一段的插件**：`dsh-tauri-session`（唯一以**工作区**为粒度批量归档会话，但入口是手动的「归档工作区」菜单）、`dsh-workspace-kit`（唯一做**工作区级软归档 + 恢复**，但状态存在浏览器 localStorage、靠手工点）、`@mzzsfy/dsh-session-manager`（唯一有真正**自动归档引擎 + 重挂载恢复通道**，但触发条件是「时间超期」而非目录消失；其失败矩阵明确写出「无匹配工作区 → 拒绝」，说明目录被删后它帮不上忙）。
4. **缺口就是**：`Workspace.status() === 'missing-dir'` 的检测 → 自动 `archiveSession`；目录回归 → 自动 `unarchiveSession`。且官方归档是 one-way（无 unarchive API），`@mzzsfy/dsh-session-manager` 已经把「直写 `storageDomain.get('workspace')` 的 `archivedSessionIds` + 同步 `registry.state` 快照」这条**可行路径和它全部的坑**公开写在 README 里，可直接复用其经验。

> 下载量口径提示：官方 `@deepseek-ai/*` 包的月下载量都在 150 万–250 万量级（远超任何社区包），明显是镜像/CI 拉取造成的放大值，**不宜与社区包横向比较热度**。社区包之间的量级可比。

---

## 二、候选表

### 2.1 需求 ① —— 自动命名（按对话内容总结）

| 名称 | npm 包名 | 仓库 | 月下载 | 能力一句话 | 覆盖判定 | 证据（原文） |
|---|---|---|---|---|---|---|
| 会话标题（session-title-pattern） | `dsh-session-title-pattern` | [cq-guojia/dsh-session-title-pattern](https://github.com/cq-guojia/dsh-session-title-pattern) | 791 | 把标题统一成 `MMDD｜类型｜主题`，类型与主题由模型对**整段对话**总结，每 N 条对话重算 | **覆盖** | 「由大模型对**整段对话**总结」；「**之后每 10 条对话**（可配）—— 本插件触发一次重算」；「主题 —— 对**整段对话**的凝练，而不是取首条消息的前几个字」 |
| TitleCraft | `dsh-titlecraft` | [TyrantG/dsh-titlecraft](https://github.com/TyrantG/dsh-titlecraft) | 538 | 7 套标题模板 + 语义精修 + 206 图标；回合结束后可调模型更新标题；原生重命名弹窗加「AI 生成摘要 / 从摘要生成标题」 | **覆盖** | 「Turn-end refinement can update the title after a human turn completes successfully」；「AI generate summary creates an editable summary and suggests a type and icon」 |
| 官方 all-prompts provider | `@deepseek-ai/dsh-session-title-all-prompts-llm` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 4356 | 官方：按**所有用户消息**生成标题 | **覆盖（官方）** | 描述原文：`All-user-messages LLM provider plugin for DeepSeek Harness session titles` |
| 会话增强 xc | `dsh-session-xc` | [xchannel1987/dsh-session-xc](https://github.com/xchannel1987/dsh-session-xc) | 1778 | 新会话**首轮**结束后用会话自身模型自动起名并钉住标题 | **部分覆盖**（只用第一轮上下文，非全对话总结） | 「取**第一轮**的用户提问 + 助手回答（思维链丢弃），起名质量远高于只取首条消息」；「每个会话只触发一次」 |
| 会话标题（ly6170） | `dsh-session-title` | [ly6170/dsh-session-title](https://github.com/ly6170/dsh-session-title) | 183 | 给模型一个按使用者自定义规则设置会话标题的工具，规则在设置页配置 | **部分覆盖**（模型主动调用工具，非自动总结） | 「给模型一个按使用者自定义规则设置会话标题的工具，规则在设置页「会话标题」里配置」 |
| 会话标题格式 | `dsh-session-title-format` | 未找到仓库链接（packument 无 `repository` 字段） | 208 | `set_session_title` 工具把当前会话改名为 `MMDD｜类型｜主题` | **部分覆盖**（工具式改名） | 「DSH plugin: set_session_title tool renaming the calling agent's session to「MMDD｜类型｜主题」」 |
| 官方 title 底座 | `@deepseek-ai/dsh-session-title` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 1949431 | 标题服务 + provider 注册表（回退规则、`refresh()`、`rename()`） | 支撑组件（已核实，不重复验证） | `Log-backed session title service and provider registry` |
| 官方 LLM 策略 | `@deepseek-ai/dsh-session-title-llm` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 1726304 | 各 provider 共享的 LLM 生成策略 | 支撑组件 | `Shared LLM generation policy for DeepSeek Harness session-title providers` |
| 官方 first-prompt provider | `@deepseek-ai/dsh-session-title-first-prompt-llm` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 1740126 | 官方：只按第一条用户消息生成标题（本机已装） | 部分覆盖（已核实） | `First-message LLM provider plugin` |

### 2.2 需求 ② —— 工作区目录消失 → 归档 / 目录回归 → 恢复

| 名称 | npm 包名 | 仓库 | 月下载 | 能力一句话 | 覆盖判定 | 证据（原文） |
|---|---|---|---|---|---|---|
| tauri session | `dsh-tauri-session` | [dsh-tauri-desk/dsh-tauri-plugins](https://github.com/dsh-tauri-desk/dsh-tauri-plugins) | 2769 | 在官方「删除工作区」菜单旁**追加「归档工作区」入口**，一次归档该工作区全部会话；设置页管理「已归档的聊天」 | **部分覆盖（②最接近的归档侧）**。按工作区分组批量归档，但**手动点击**，不感知目录是否消失，不自动恢复 | 「并在官方工作区浏览器的「删除工作区」菜单旁 追加「归档工作区」入口」；「点击 → 客户端样式确认框 → **归档该组全部会话**」；「归档目标与会话清单全部来自运行时快照（`workspace.sessionIds`）」 |
| workspace kit | `dsh-workspace-kit` | [ice5kysl/dsh-workspace-kit](https://github.com/ice5kysl/dsh-workspace-kit) | 2372 | 工作区**软归档**（隐藏 + 可恢复、不删数据）+ ⌘K Spotlight + 替换侧栏工作区浏览器 | **部分覆盖（②最接近的恢复侧）**。工作区级手工软归档，状态存**浏览器 localStorage**，不随目录删除触发，也不自动恢复 | 「**soft archive** (hidden + restorable, no data deleted)」；「archive state is managed by the plugin (**browser-persisted**)」；「the plugin takes a "**view-layer soft archive**" approach」 |
| mzzsfy 会话管理器 | `@mzzsfy/dsh-session-manager` | [mzzsfy/dsh-plugin](https://github.com/mzzsfy/dsh-plugin) | 2406 | 会话**自动归档**（超期）+ 归档面板 + 删除进回收站 + **还原后一键重挂载** | **部分覆盖**。有真正的自动归档引擎与恢复通道，但触发是**时间超期**，不是目录消失；目录消失时它只会拒绝 | 「自动归档：host 半区对**超期**会话走官方 `workspace.archiveSession` 通道」；失败矩阵：「**重挂载、无匹配工作区 → 拒绝**，提示未找到会话所属工作区，无副作用」 |
| linxin666 会话归档 | `@linxin666/dsh-session-archive` | [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 120182 | 全量归档清单 + 批量归档/恢复 + 带级联的物理删除 + 可选自动维护策略 | **部分覆盖**。自动归档按**最后活跃时间**，不按目录存在性 | 「auto-archive sessions **inactive beyond a threshold (by last-activity time, never creation time)**」 |
| 会话管理器 | `dsh-session-manager` | [hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) | 9504 | 删除/归档/跨工作区移动/预设迁移 + 收藏、标签、批量；跨工作区移动会重写 cwd | **部分覆盖**。手工归档；「移动至工作区」可把会话搬回重建后的目录（迂回解法） | 「移动至工作区：跨工作区移动时保留历史、标题、归档状态…同时把 `cwd` 重写为目标工作区」 |
| 工作区树 | `@lynn123411/dsh-workspace-tree` | [tttnny/my-dsh](https://github.com/tttnny/my-dsh) | 2308 | 侧栏工作区浏览器：按目录嵌套、未归属落「未分组」、**安全归档区** | **部分覆盖**。手工归档，无目录消失联动 | 「安全归档区（归档有门槛、进区必可删、删除零守卫 fail-loud）」 |
| 归档管理器 | `@mlgbnb/dsh-archive-manager` | [z953218350/dsh-archive-manager](https://github.com/z953218350/dsh-archive-manager) | 18795 | 设置页预览、恢复、删除已归档会话 | **部分覆盖**（纯恢复面板） | 「preview, restore, and delete archived sessions from the settings page」 |
| 归档管理器 | `@michengai/dsh-archive-manager` | [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) | 171216 | 管理已归档会话 | **部分覆盖** | 「NPM-installable DSH Web plugin for managing archived sessions」 |
| 聊天管理器 | `dsh-chat-manager` | [WSL043/dsh-chat-manager](https://github.com/WSL043/dsh-chat-manager) | 8443 | 搜索归档、恢复对话、安全删除 | **部分覆盖** | 「search archives, restore conversations, and delete safely」 |
| 归档会话 | `@omdp/dsh-archived-sessions` | [XJungit/omdp](https://github.com/XJungit/omdp) | 1397 | 设置页查看/释放/删除已归档会话（含按树删除子会话与孤儿清理） | **部分覆盖** | 「DSH 归档会话管理：设置页查看、释放、删除已归档会话（含按树删除子会话与孤儿清理）」 |
| 归档对话 | `dsh-archived-conversation` | [Li-canghai/dsh-archived-conversation](https://github.com/Li-canghai/dsh-archived-conversation) | 1227 | 设置 → 已归档里搜索、浏览、取消归档、删除 | **部分覆盖** | 「Archived-conversation manager… search, browse, unarchive, and delete archived conversations in Settings → 已归档」 |
| 归档管理器（qinyre） | `dsh-plugin-archive-manager` | [qinyre/dsh-plugin-archive-manager](https://github.com/qinyre/dsh-plugin-archive-manager) | 723 | 浏览、取消归档、**按规则自动归档** | **部分覆盖**。规则自动归档，但规则非「目录消失」 | 「Archive manager for dsh sessions: browse, unarchive, and **auto-archive by rules**」 |
| 会话管家 | `dsh-session-steward` | [drscrewdriver/dsh-session-steward](https://github.com/drscrewdriver/dsh-session-steward) | 3182 | 会话历史文件（归档浏览与清理）+ 会话健康检查 | **部分覆盖** | 「会话管家 —— 会话历史文件（归档浏览与清理）与会话健康检查…不碰会话日志、只做可逆处置」 |
| 归档（gestaltrun 分叉） | `@gestaltrun/dsh-session-archive` | [gestaltrun/dsh-web](https://github.com/gestaltrun/dsh-web) | 115 | `@linxin666/dsh-session-archive` 的同源分叉（同描述） | **部分覆盖** | 描述与 linxin666 版逐字相同 |
| 工具箱 | `dsh-toolbox-web` | [AbcdefgXW/dsh-toolbox-web](https://github.com/AbcdefgXW/dsh-toolbox-web) | 2257 | 会话/回收站/子目录/搜索/预设管理 | **部分覆盖** | 「dsh 工具箱：会话/回收站/子目录/搜索/预设/配置管理」 |
| 会话清理 | `@zfdx123/dsh-session-cleaner` | [zfdx123/dsh-atelier](https://github.com/zfdx123/dsh-atelier) | 1826 | 彻底删除 DSH 会话（store 条目、工作区记录、磁盘产物、投影缓存一并清） | **无关 ②**（删除而非归档恢复） | 「彻底删除 DSH 会话——实时 store 条目、工作区记录、磁盘产物与投影缓存行一并清掉」 |
| 官方归档设置页 | `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 46073 | 官方归档集合设置页，每行一个 Unarchive 动作 | 官方底座 | `Archived-session settings page: the registry-global archive set with one Unarchive action per row` |
| 官方工作区注册表 | `@deepseek-ai/dsh-workspace` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 1876835 | `ctx.workspaceRegistry` 的 archive/unarchive/pin；`Workspace.status()` 返回 `ok \| missing-dir` | 官方底座（已核实） | `Workspace entity registry (ctx.workspace)` |

### 2.3 插件市场类（跑 `dsh plugin marketplace` 查询的结果）

与 ①② 均**无关**，仅记录以证明该关键词下的生态面貌：

| npm 包名 | 月下载 | 仓库 |
|---|---|---|
| [`dshmarket`](https://www.npmjs.com/package/dshmarket) | 481575 | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) |
| [`dsh-plugin-marketplace`](https://www.npmjs.com/package/dsh-plugin-marketplace) | 7021 | [Scorp1o117/dsh-plugin-marketplace](https://github.com/Scorp1o117/dsh-plugin-marketplace) |
| [`@springbrand/dsh-plugin-marketplace`](https://www.npmjs.com/package/@springbrand/dsh-plugin-marketplace) | 777 | [springbrand-lab/dsh-plugin-market](https://github.com/springbrand-lab/dsh-plugin-market) |
| [`@w2112515/dsh-plugin-marketplace`](https://www.npmjs.com/package/@w2112515/dsh-plugin-marketplace) | 508 | [w2112515/dsh-plugin-marketplace](https://github.com/w2112515/dsh-plugin-marketplace) |
| [`@dshindex/dsh-plugin-marketplace`](https://www.npmjs.com/package/@dshindex/dsh-plugin-marketplace) | 347 | [lijma/dsh-plugin-marketplace](https://github.com/lijma/dsh-plugin-marketplace) |
| [`@starpivot/dsh-plugin-marketplace`](https://www.npmjs.com/package/@starpivot/dsh-plugin-marketplace) | 296 | [StarPivotNet/dsh-plugins-public](https://github.com/StarPivotNet/dsh-plugins-public) |
| [`@lovstudio/dsh-plugin-marketplace`](https://www.npmjs.com/package/@lovstudio/dsh-plugin-marketplace) | 281 | [lovstudio/dsh-plugin-marketplace](https://github.com/lovstudio/dsh-plugin-marketplace) |
| [`@ruihuahe/dsh-plugin-marketplace`](https://www.npmjs.com/package/@ruihuahe/dsh-plugin-marketplace) | 166 | [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager) |
| [`hi-dsh`](https://www.npmjs.com/package/hi-dsh) | 149 | [hi-dsh/hi-dsh](https://github.com/hi-dsh/hi-dsh) |

### 2.4 GitHub 侧检索结果

- `https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=50` 返回 HTTP 200，`total_count: 17061`。但**按 star 排序毫无信号**：前几名是与 ①② 完全无关的巨型仓库——[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（241852 stars）、[nexu-io/open-design](https://github.com/nexu-io/open-design)（99101）、[tt-a1i/archify](https://github.com/tt-a1i/archify)（75910）、[ruvnet/ruflo](https://github.com/ruvnet/ruflo)（73677）、[voyager-crew/voyager](https://github.com/voyager-crew/voyager)（20280）、[EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS)（13325）、[MemTensor/MemOS](https://github.com/MemTensor/MemOS)（ⓘ 见下）。说明 `dsh-plugin` topic 已被大量泛化项目占用，**该查询对定位 ①② 无帮助**。
- 唯一有价值命中：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（17561 stars，CC0-1.0）—— DSH 插件精选列表，可用作人工复核入口。其 README 正文未能通过 HTML 抓取完整取得（页面返回的是导航壳），未从中读出关于 ①② 的新条目。
- MemOS 的 star 数在返回体中被截断，故此处不给出具体数字（不编造）。

---

## 三、我实际跑过的查询（可复现）

npm registry 搜索 API（每条 `size=20`）：

1. `dsh session title` → 220767 命中；抓到 `dsh-session-title-pattern`、`dsh-titlecraft`、官方 title 系列
2. `dsh auto rename conversation` → 239859 命中；无新相关项（返回大量官方基础包与 `dshmarket`）
3. `dsh session archive` → 118460 命中；抓到 `@linxin666/dsh-session-archive`、`@michengai/dsh-archive-manager`、`dsh-session-manager`
4. `dsh workspace archive` → 72876 命中；抓到 `dsh-workspace-kit`、`@mlgbnb/dsh-archive-manager`
5. `dsh session summarize` → 108371 命中；**无任何总结类标题插件**（返回官方 compaction / session 基础包）
6. `dsh 会话 归档` → 97629 命中；抓到 `dsh-plugin-archive-manager`、`dsh-tauri-session`、`dsh-session-xc`、`@mzzsfy/dsh-session-manager`、`dsh-session-steward` 等
7. `dsh plugin marketplace` → 317273 命中；见 2.3
8. `dsh plugin workspace session` → 414935 命中；仅官方基础包
9. （补充）`dsh workspace restore hidden session` → 2941334 命中；无新相关项
10. （补充）`dsh workspace dir missing auto` → 310799 命中；**未找到任何以目录缺失为触发条件的插件**

npm packument（读取完整 README）：`dsh-session-title-pattern`、`dsh-titlecraft`、`@mzzsfy/dsh-session-manager`、`dsh-session-manager`、`dsh-tauri-session`、`@linxin666/dsh-session-archive`、`dsh-session-xc`。

GitHub：`api.github.com/search/repositories?q=topic:dsh-plugin...`（HTTP 200）、`github.com/awesome-dsh-plugin/awesome-dsh-plugin`（HTTP 200，仅取到导航壳）。

> 注：`raw.githubusercontent.com` 在本机对该会话不可达（`fetch failed`），故所有 README 证据改用 npm packument 的 `readme` 字段获取，来源同为上游仓库发布物。

---

## 四、需求 ①② 的生态占位判定：是否已有人做、最接近的是谁、还缺什么

### ① 按对话内容自动命名 —— **已有人做，且不止一个，属于红海**

- **最完整**：[`dsh-session-title-pattern`](https://github.com/cq-guojia/dsh-session-title-pattern)（791/月）。它的定位与需求 ① 几乎逐字重合：模型对**整段对话**总结出类型与主题，并且**每 10 条对话重算一次**（`retitleEvery` 可配），失败时保留上一版标题或退回本地兜底。还额外处理了标题显示宽度（注入 CSS 放宽面包屑 `max-width`）。
- **最灵活**：[`dsh-titlecraft`](https://github.com/TyrantG/dsh-titlecraft)（538/月）。7 套模板 + `{date}/{type}/{topic}/{icon}` 自定义 + 206 个本地图标 + 「拿不准就不调模型」+ **回合结束语义精修** + 原生重命名弹窗里的「AI 生成摘要 → 从摘要生成标题」两步工作台。注意它自称**会接替 DSH 内置 provider，而 DSH 同时只能用一个标题 provider**，即与 `dsh-session-title-pattern` 互斥。
- **官方已有**：`@deepseek-ai/dsh-session-title-all-prompts-llm`（按所有用户消息）。本机未装的那个版本正是它——所以 ① 的「按全部对话而非首条」能力**官方本身就提供**。
- **结论**：① 没有任何空白可言。若仍要做，唯一站得住的差异化理由是「官方与现有插件都不满足的具体形态」（例如自定义触发时机、多语言命名策略、按项目分别配置规则），否则就是重复实现。

### ② 工作区目录消失 → 自动归档；目录回归 → 自动恢复 —— **没有人做，是真空白**

把生态拆成三段看，每段都有人做，但**没有任何一个插件把三段连起来**：

| 段落 | 已有实现 | 缺的那一环 |
|---|---|---|
| **工作区粒度的归档/恢复** | `dsh-tauri-session` 的「归档工作区」一次归档该组全部会话；`dsh-workspace-kit` 的工作区软归档（隐藏 + 恢复） | 两者都是**手工触发**。`dsh-tauri-session` 不感知目录状态；`dsh-workspace-kit` 的状态是**浏览器 localStorage 的视图层状态**，宿主侧刻意只读，跨设备/清缓存即失效 |
| **自动归档引擎** | `@mzzsfy/dsh-session-manager`（超期）、`@linxin666/dsh-session-archive`（最后活跃超阈值）、`dsh-plugin-archive-manager`（按规则） | 触发条件全是**时间**，没有一个是**目录存在性**。没有一个读 `Workspace.status() === 'missing-dir'` |
| **归档后的恢复通道** | `@mzzsfy/dsh-session-manager` 的「重新挂载」（`workspace.attachSession` + 台账 + 系统回收站）；官方 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` 的逐行 Unarchive | `@mzzsfy` 的失败矩阵原文：「**重挂载、无匹配工作区 → 拒绝**，提示未找到会话所属工作区，无副作用」——即**目录被删掉之后，它明确帮不上忙**，而这正是需求 ② 要处理的场景 |

**最接近的是谁（分句回答）**
- 最接近「按工作区归档一批会话」的：**`dsh-tauri-session`**。
- 最接近「工作区级归档 + 恢复、且不改数据」的：**`dsh-workspace-kit`**。
- 最接近「自动归档 + 自动恢复管线」、且工程细节最可借鉴的：**`@mzzsfy/dsh-session-manager`**。

**还缺什么（即本插件的机会）**
1. **缺失的触发器**：周期性（或文件系统事件）遍历已注册工作区，`Workspace.status() === 'missing-dir'` → 对该工作区名下会话批量 `ctx.workspaceRegistry.archiveSession()`。生态中零实现。
2. **缺失的反向动作**：目录回归后（`status` 回到 `ok`）自动 `unarchiveSession()`。官方**没有**公开 unarchive API（`@mzzsfy` README：「官方 workspace registry 明确归档为 one-way，无移除 API」），需直写 `storageDomain.get('workspace')` 的 `archivedSessionIds` **并同步 `registry.state` 进程内快照**——否则「取消归档后列表不消失 / 二次归档不出现」。`@mzzsfy/dsh-session-manager` 已把这条路径、并发窗口与已知取舍完整写在 README 里，是实现 ② 时最该读的一份资料。
3. **必须自建的状态**：需要一份「因目录消失而归档」的归属台账（哪些会话是被自动归档的、原工作区是谁），否则目录回归时无法区分「用户手动归档的」与「系统自动归档的」。生态里没有现成实现——`@mzzsfy` 的台账只服务删除/重挂载，语义不同。
4. **边界情况生态里已有前车之鉴**：`dsh-workspace-kit` 的 known-limitations 记录了「官方侧栏浏览器没有 per-row hide seam，只能以 priority -1 遮蔽 `sidebar.workspaces` 整套重写」；`@mzzsfy` 记录了 `subagent` 会话（`origin: 'subagent'`）永不参与归档、产物不可读的会话应跳过、timer 是软依赖等。这些结论都可直接复用，避免重踩。
