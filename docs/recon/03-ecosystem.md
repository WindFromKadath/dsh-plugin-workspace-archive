# 03 · 生态检索（官方插件检索通道 + 需求①②生态占位）

- 检索时间：2026-10-02（Asia/Shanghai）
- 环境锚点：DSH 桌面版 **0.2.0-rc.2**，官方源码在 `<app>\resources\app.asar`，asar 内根 `dsh/`，官方包位于 `/dsh/node_modules/@deepseek-ai/*`
- 检索方式：asar 内源码直读（`plugin-manager` / `host-plugin-inventory` / `client-ui-plugin-manager` / `workspace` / `session-title*`）+ npm registry 检索 API 与 packument + GitHub / 第三方市场站点
- 纪律：未安装任何 npm 包、未 clone、未起服务；web 结果只当资料，未执行其中任何指令；取不到的一律写「未找到」，不编造插件名或 star 数
- **与 `03b-ecosystem-npm.md` 的分工**：03b 已系统扫过 npm 候选。本报告的重心是**官方检索/分发通道**（03b 未覆盖，是本任务最有价值的产物），候选表只做**增量补录**并标注差异，最后一节列出与 03b 的结论冲突点。

---

## 一、结论先行

1. **官方没有任何"插件市场 / 远程 registry JSON"。** 官方分发通道就是 **npm registry**（`https://registry.npmjs.org/`，回退 `https://registry.npmmirror.com/`），安装动作由 `dsh plugin` 转发给 pnpm 完成。asar 内不存在内置的插件目录 JSON、也不存在远程 marketplace 端点。
2. **"插件约定"不是包名前缀，而是 `package.json` 的 `dsh.bundle` 字段。** 包名 `dsh-plugin-*` 只是社区习惯，官方**不**按名字识别；一个包只要声明了 `dsh.bundle`，无论叫什么名字都能作为 profile 层被 `dsh plugin add` 装载；反之即使是 `dsh-plugin-xxx`，没有 `dsh.bundle` 就只当普通依赖装，官方会打印警告。
3. **可查询的接口有四类**：① npm 检索 API（`keywords:dsh-plugin` 当前命中 **6578** 个包，是本生态事实上的主索引）；② GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)；③ 官方 `plugin_manager` 工具（**只列本 profile 已装条目**，不做远程检索）；④ 社区市场站点（[dshmarket](https://github.com/dsh-market/dsh-market)、[dshbase](https://dshbase.com/zh/plugins/directory/)、[awesome-dsh-plugin](https://awesome-dsh-plugin.com/)、[dshfind](https://dshfind.com/)）。
4. **需求① 已被生态做透**，且 03b 漏掉了其中下载量最高、语义最贴的一个：`@weibaohui/dsh-smart-title`（每轮结束对「用户消息 + 助手回答」完整转写做总结）。**再做①属于重复造轮子**。
5. **需求② 仍是真空白**：未找到任何插件以"工作区目录消失"为触发条件自动归档、并在目录回归后自动恢复。更关键的是**官方语义与②直接冲突**——官方规定"移除项目后再次添加同一目录会从空项目开始，不会带回旧会话"，且"会话删除与文件夹移除是彼此独立且尚未提供的功能"，因此②不能靠官方现成语义拼出来，必须自己按**路径 → 会话**映射重建。
6. **一处对 03b 的更正**：03b 结论称"官方归档是 one-way（无 unarchive API）"，这在 0.2.0-rc.2 上**不成立**。官方 `@deepseek-ai/dsh-workspace` 存在 `unarchiveSession(sessionId)`，且有官方 UI 包 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions`。②的恢复侧因此有官方通道可用，实现难度低于 03b 的判断。

---

## A 官方插件检索通道

### A.1 分发模型：npm registry + pnpm，无官方 marketplace 端点

`@deepseek-ai/dsh-plugin-manager` 的浏览器安全入口 `./registry` 把规则写死在源码里（`/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/registry.js`）：

```js
/** npm's own registry: what pnpm names without any configuration, and the one public registry a plan trusts as such. */
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
/** Public npmmirror URL shared by the fallback configuration and public-registry comparison. */
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/';
/** An http(s) URL, as pnpm's `--registry` takes it. */
export const REGISTRY_URL = /^https?:\/\/\S+$/;
```

配置键与默认值（`dsh-plugin-manager/README.md` 配置表）：

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `registry` | pnpm 自身的 | 查询与安装**首选**的 registry（http(s) URL）；缺省时用 pnpm 配置里的那个 |
| `fallbackRegistries` | `['https://registry.npmmirror.com/']` | 依次回退的 registry；前一个不可达、超时、或答"没有此包/版本"（镜像未同步）时换下一个 |
| `inspectTimeoutMs` | `20000` | 单次 registry 查询超时（ms） |
| `githubConnectionTimeoutMs` | `5000` | 安装前 `git ls-remote` 校验 GitHub 仓库的时限（ms） |
| `pnpmCommand` | `pnpm` | pnpm 可执行名/路径 |

**关键设计**：不在配置集合里的 registry 会被**单独询问**，绝不回退到公共 registry——所以私有 registry 不会泄漏。官方 registry 与镜像之间的关系由 `registryPlan(requested, configured)` 决定，失败归因由 `attributeFailure()` 决定（区分 `registry` / `spec-host` / `other`）。

客户端侧（`@deepseek-ai/dsh-client-ui-plugin-manager/lib/index.js`）也**只**探测这两个地址，没有任何第三方目录：

```js
const requests = ["https://registry.npmjs.org/-/ping", "https://registry.npmmirror.com/-/ping"].map(async (endpoint) => ({
```

⇒ **结论**：官方插件的"取数据处"就是 **npm registry 的 package 元数据**。想检索官方生态，等价于检索 npm。

### A.2 清单约定：`dsh.bundle`（bundle）/ `dsh.profile`（profile）/ `dsh.client`（客户端半）

官方文档 [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)（源文件 `docs/user/develop/basic/publish.md`）给出两个概念：

- **bundle**：一个 npm 包，携带一层配置。manifest 声明 `dsh.bundle`，回答"这个包贡献什么"——一个 patch 文件，插入或覆盖插件行。
- **profile**：`$DSH_HOME/profiles/<name>` 下的目录，描述一个可运行组合。manifest 声明 `dsh.profile`，回答"哪些 bundle 以什么顺序组成这套配置"。

最小 bundle manifest（官方原文示例）：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 是按 `id` 定位插件行的层：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

**无 `dsh.bundle` 的后果**（`dsh-plugin-manager/lib/index.js` 实测字符串）：

```
dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

安装校验也会拒绝：`if (!inspection.bundle) return refused("not-a-bundle", ...)`。

客户端半（浏览器侧）用 `dsh.client` 声明平台与注入的服务，本机真实样例（`dsh-archive-restore` packument）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "inject": ["slots", "sessions", "workspaces"], "platform": "web" } }
```

以及 `engines.dsh` 声明兼容的内核版本（例：`"engines": { "dsh": ">=0.2.0-rc.1" }`）；安装前官方会用 pnpm registry 查询解析出版本与 peer，**peer 不兼容则在 pnpm 跑起来之前就拒绝**，不下载、不执行构建脚本。豁免写在 profile 自己的 `compatibility.json`（精确 `package-name@version` → 精确 DSH 运行时版本列表）。

### A.3 安装 spec 的四种形态（`inspect(spec)` 的判定）

`dsh-plugin-manager` README 明确 `inspect(spec, options)` 在安装前先读 spec：

| spec 形态 | 例子 | 官方如何读 |
|---|---|---|
| registry 包名 | `@weibaohui/dsh-smart-title` | 经 `pnpm view` 查 registry（在 profile 目录跑，继承同一 proxy/认证） |
| 本地路径 | `./hello-plugin`、`file:/path` | 读该路径自己的 `package.json` |
| git 地址 | `github:SZMY-haruhi/dsh-session-plus`、可钉 `#<sha>` | 只答形式与被 fetch 的 `host`；安装前先 `git ls-remote` 校验 |
| tarball | `./pkg-0.1.0.tgz`（`pnpm pack` 产物） | 同上，只答形式与 host |

**git 安装的构建陷阱**（官方文档单列一节）：git 安装取的是**源码不是产物**，不会跑 `build`，所以作者必须提供 `prepare` 脚本；且 pnpm ≥10 默认拒绝执行 git 依赖的 `prepare`，首次 `add` 会失败，需在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds: { <pkg>: true }` 后重试。若不想让用户授权构建，就发 npm（`pnpm publish` 时已构建 `lib/`）或发 tarball。

### A.4 官方可用的查询入口（命令与接口）

| 入口 | 形态 | 能查到什么 | 备注 |
|---|---|---|---|
| `dsh plugin --profile <name> <args...>` | CLI | 转发给 pnpm，**所有 pnpm 动词可用**（`add` / `remove` / `update` / `why` …） | 本机安装目录 `<app>`；profile `$env:DSH_HOME\profiles\desktop` |
| `dsh --profile <name> --dump-config` | CLI | 打印合成后的层（含 `# == <bundle>` 段），**不启动**即可验证层 | 官方文档推荐 |
| `plugin_manager` 工具 | Agent 工具 | 列出插件条目与 bundle、做 profile 级变更；`list_version_exemptions` 取运行时版本 | 包 `@deepseek-ai/dsh-plugin-manager/tools`；本机在 preset `standard`/`ptc` 中 `disabled: true`，仅 Creator 模式启用 |
| `plugin_manager/install-log` / `install-state` 事件 | 宿主事件流 | 每次 pnpm 运行的输出流 / `installing`/`cancelling`/`applying` 状态 | `installing` 每个被询问的 registry 各播报一次，带 `attempt`、位置与 plan 长度 |
| `waitForInstall(requestId)` | API | 用 requestId 恢复丢失的响应 | 已完成结果不保留；返回 `null` 不代表成功或取消 |
| Web 侧边栏 **Plugins** 页 | GUI | 管理当前 profile 的 bundle 与其行（设置里的 Plugin list 是**只读**的） | 包 `@deepseek-ai/dsh-client-ui-plugin-manager`；设置页只读列表是 `dsh-client-ui-settings-plugin-inventory` |
| `@deepseek-ai/dsh-host-plugin-inventory` | 宿主服务 | 提供已装插件清单给上述 UI/工具 | 本机 profile 已启用（id `plugin-inventory`） |

**官方没有的**：远程插件搜索、插件评分、插件目录 JSON。`plugin_manager` 的 `listBundles` 只列**本 profile 已装**的条目（含 disabled 与 `error`）。

**生态检索实际该用的接口**（本报告采用）：

```bash
# 1) npm 检索 API —— 生态主索引，keywords 是事实上的分类键
https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=25        # 当前 total = 6578
https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin%20archive&size=25
# 2) 单个包的完整 packument（含 readme，是取证据最快的方式）
https://registry.npmjs.org/dsh-plugin-archive-manager
https://registry.npmjs.org/@weibaohui%2Fdsh-smart-title        # scope 包要把 / 编码成 %2F
# 3) GitHub topic
https://github.com/topics/dsh-plugin
```

### A.5 第三方市场 / 目录（社区，非官方，但与①②候选相关）

这些**不是**官方通道，但它们是 03b 与我实际找到候选的主要来源，记录以便复现检索：

| 名称 | 链接 | 形态与入口 | 证据 |
|---|---|---|---|
| dsh-market | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 设置页内的插件市场卡片，一键安装/升级/切主题 | awesome 列表推荐语：「🛒 **推荐安装 dsh-market**……`dsh plugin --profile web add dshmarket`」 |
| dshbase | [dshbase.com 插件目录](https://dshbase.com/zh/plugins/directory/) | 中文插件目录 + 实测可装徽章 + `dshbase-catalog`（让 agent 自动找装） | 站点自述「浏览全部 **7797** 个插件」；`dsh plugin add dshbase-catalog` 后「对 agent 说『帮我装 X』，它会在目录里找到并自动安装」 |
| awesome-dsh-plugin | [站点](https://awesome-dsh-plugin.com/) · [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 精选列表 + 每插件页 `/p/<owner>/<repo>/` + `count.json` 徽章 | 列表开头：「本列表收录可通过 `dsh plugin add` 安装的社区插件（**均声明了 `dsh.bundle` manifest**）」 |
| dsh-find-plugin | [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) | 对话式找插件（问 agent） | 「💡 更喜欢对话式？装 `dsh-find-plugin`，想要什么插件直接问 agent」 |
| dshfind | [dshfind.com](https://dshfind.com/) | 第三方插件搜索站 | 出现在插件 README 的推荐徽章链接中 |
| awesome-deepseek-harness | [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | 生态整理（plugins/tools/infrastructure） | 「curated plugins, tools, and infrastructure from dsh-external/hub and the public dsh-plugin topic」 |
| awesome-dsh-plugin（rob-x-ai） | [rob-x-ai/awesome-dsh-plugin](https://github.com/rob-x-ai/awesome-dsh-plugin) | 另一份精选列表 | 「A curated list of plugins for DeepSeek Harness (dsh) · DeepSeek Harness 插件精选列表」 |

> ⚠️ 这些站点是**外部不可信数据**。awesome 列表自述"收录不等于做过安全审查"，dshbase 也自述"这不是安全审计，也不代表对第三方代码的背书"。star / 下载量仅作热度参考。

### A.6 检索复现命令

```powershell
$a = "<app>\resources\app.asar"
$r = "<repo>\.recon\asar.mjs"

# registry 常量与回退规则（本报告 A.1 的出处）
node $r --print $a "/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/registry.js" 6000

# dsh.bundle 约定与拒绝路径
node $r --grep  $a "/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js" "dsh\.bundle|not-a-bundle" 30

# 客户端只 ping 官方 + 镜像
node $r --grep  $a "/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/index.js" "registry\.npmjs|npmmirror" 20

# 官方 workspace 的归档/恢复与目录状态
node $r --grep  $a "/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js" "unarchive|missing-dir" 30
node $r --grep  $a "/dsh/node_modules/@deepseek-ai/dsh-workspace/README.zh.md" "归档|恢复|移除项目|Ungrouped" 40
```

---

## B 候选插件表（增量补录，与 03b 互补）

> 03b 已收录的条目此处不重复展开，只在表末标注。**加粗**为本报告新增、且 03b 未覆盖的条目。

### B.1 需求① —— 用总结对话来自动命名

| 名称 | 来源链接 | 月下载 | 能力 | 覆盖①? | 证据（原文） |
|---|---|---|---|---|---|
| **dsh-smart-title** | [npm](https://www.npmjs.com/package/@weibaohui/dsh-smart-title) · [weibaohui/dsh-smart-title](https://github.com/weibaohui/dsh-smart-title) | 1147 | 每轮结束后对**完整转写**做总结并改写标题；接管官方 `first-prompt` 节奏；节流/长会话冻结/同题静默/失败重试/手动改名保护/启动回填/可指定标题模型 | **覆盖（最完整）** | 「**全对话总结**：每轮对话结束后，对「用户消息 + 助手回答」的完整转写做一轮总结，标题反映会话真正在做的事，而不是复述第一句话」；「安装时会自动禁用内置的 first-prompt 标题提供方（`session-title` 服务只允许一个提供方，两者不能共存）」；「你在界面上手动改过的标题（用户钉住）绝不被自动覆盖」 |
| dsh-session-title-pattern | [npm](https://www.npmjs.com/package/dsh-session-title-pattern) · [cq-guojia/dsh-session-title-pattern](https://github.com/cq-guojia/dsh-session-title-pattern) | 791 | 统一成 `日期｜类型｜主题`，类型与主题由模型对整段对话总结 | **覆盖**（03b 已收录） | npm 描述：「a model **summarizes the type and topic of the whole conversation**」 |
| **dsh-current-title** | [npm](https://www.npmjs.com/package/@klarkxy/dsh-current-title) · [klarkxy/dsh-plugins](https://github.com/klarkxy/dsh-plugins) | 928 | Auto Title：让标题跟随**最新任务**；手工设过的标题不动 | **覆盖（偏"跟随最新"）** | 「Auto Title: keep session titles **following the latest task**; names you set by hand stay put.」 |
| **dsh-autotitle** | [npm](https://www.npmjs.com/package/@hanxu131/dsh-autotitle) · [ECHOUniverse/dsh-autotitle](https://github.com/ECHOUniverse/dsh-autotitle) | 335 | `/title` 斜杠命令：从对话生成标题（智能裁剪 + 可选确认） | **部分覆盖**（人工触发，非全自动） | 「DeepSeek Harness slash command `/title`: **generate a session title from the conversation** with smart trimming and optional confirm」 |
| **smart-session-title** | [npm](https://www.npmjs.com/package/smart-session-title) · [y2zyyr/smart-session-title](https://github.com/y2zyyr/smart-session-title) | 1690 | 替换官方 title provider：超长首条 prompt 改为压缩而非失败，弱 prompt 加闸 | **无关①**（仍只看首条 prompt，不做对话总结） | 「Replacement session-title provider for DeepSeek Harness: **compresses oversized first prompts** instead of failing, and gates weak prompts.」 |
| **dsh-session-title（StarPivot）** | [npm](https://www.npmjs.com/package/@starpivot/dsh-session-title) · [StarPivotNet/dsh-plugins-public](https://github.com/StarPivotNet/dsh-plugins-public) | 121 | 给 auto-title 提供设置页（提示词 + 可选标题模型），并拦截 `purpose=session-title` 的 LLM 调用 | **部分覆盖**（提供配置/拦截，不产生总结） | 「Settings page for auto-title prompt and optional title model; **host intercept of purpose=session-title LLM calls**」 |
| **dsh-titlecraft** | [npm](https://www.npmjs.com/package/dsh-titlecraft) · [TyrantG/dsh-titlecraft](https://github.com/TyrantG/dsh-titlecraft) | 538 | 可配置标题模板 + 语义精修 + 图标 + 安全模型回退 | **覆盖**（03b 已收录） | 「Configurable DSH session title templates with **semantic refinement**, icons, and safe model fallback」 |
| **dsh-client-session-title-edit** | [npm](https://www.npmjs.com/package/@khorsheed/dsh-client-session-title-edit) | 932 | 会话标题旁的编辑控件，走官方 `session.rename` RPC | **无关①**（纯手动改名；且用户来源标题会钉住自动重生成） | 「an edit control beside the title that renames the current session through the official **session.rename RPC** (the user-sourced title pins against automatic regeneration)」 |
| **dsh-session-title-format / dsh-session-title(ly6170)** | [npm](https://www.npmjs.com/package/dsh-session-title-format) · [ly6170/dsh-session-title](https://github.com/ly6170/dsh-session-title) | 208 / 183 | 给模型一个 `set_session_title` 工具，按用户规则改标题 | **部分覆盖**（模型主动调用，非自动总结） | 「DSH plugin: `set_session_title` tool renaming the calling agent's session to「MMDD｜类型｜主题」」（03b 已收录） |
| **Automatic-session-renaming-for-dsh** | [lyxx999/Automatic-session-renaming-for-dsh](https://github.com/lyxx999/Automatic-session-renaming-for-dsh) | 未找到 | 基于**全部会话消息**的 LLM 总结标题；首条提示词与 `/handoff` 后自动命名；会话头按钮或 `/auto…` | **覆盖** | awesome 列表原文：「DSH 会话自动重命名（session rename）：基于**全部会话消息**的 LLM 总结标题，首条提示词与 `/handoff` 后自动命名，会话头按钮或 `/auto...」 |
| **dsh-session-icons** | [fengb3/dsh-session-icons](https://github.com/fengb3/dsh-session-icons) | 未找到 | 标题生成时用**同一路由的辅助模型**画一枚 24×24 单色 SVG 隐喻图标，带磁盘缓存 | **无关①**（产出图标而非标题；但复用了标题生成的触发点） | 「侧边栏会话标题图标：**标题生成时用同一路由的辅助模型调用**画一枚 24×24 单色 SVG 隐喻图标」 |
| **dsh-enhance-tool** | [dcrzsy/dsh-enhance-tool](https://github.com/dcrzsy/dsh-enhance-tool) | 未找到 | 一站式界面增强，其中含「**智能会话标题**」 | **部分覆盖**（打包在综合插件里，未说明触发与输入范围） | 「DeepSeek Harness Web 一站式界面增强：……**智能会话标题**、对话宽度可调……」 |
| 官方 first-prompt provider | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | — | 只按第一条用户消息生成标题（**本机已装**，见 `cordis.yml` 的 `session-title-llm` 行） | 部分覆盖（官方底座） | 本机 asar 内为 `@deepseek-ai/dsh-session-title-first-prompt-llm`；本会话实际标题是 `fallbackMaxBytes:40` 的字节截断（见 `00-lead-verified-facts.md` §1.3） |
| 官方 all-prompts provider | [npm](https://registry.npmjs.org/@deepseek-ai/dsh-session-title-all-prompts-llm) | 4356 | 按**所有用户消息**生成标题；**本机未装** | 部分覆盖（只看 user 消息，不看助手回答） | 描述「All-user-messages LLM provider plugin for DeepSeek Harness session titles」（03b 已收录） |

### B.2 需求② —— 工作区目录消失 → 归档 / 目录回归 → 恢复

| 名称 | 来源链接 | 月下载 | 能力 | 覆盖②? | 证据（原文） |
|---|---|---|---|---|---|
| **dsh-session-archive（linxin666）** | [npm](https://www.npmjs.com/package/@linxin666/dsh-session-archive) · [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 120182 | 全量归档清单 + 批量归档/恢复 + 级联物理删除 + **可选自动策略**；自带 loopback 路由加固 | **部分覆盖**（自动归档判据是**最后活跃时间**，不感知目录存在性） | 「auto-archive sessions **inactive beyond a threshold (by last-activity time, never creation time)**」；「`autoArchiveEnabled` + `autoArchiveDays` (1–3650, default 7)」；「Archiving never deletes data. An archived session only disappears from grouping surfaces; unarchiving restores it with its workspace slot intact.」 |
| **dsh-plugin-archive-manager（qinyre）** | [npm](https://www.npmjs.com/package/dsh-plugin-archive-manager) · [qinyre/dsh-plugin-archive-manager](https://github.com/qinyre/dsh-plugin-archive-manager) | 723 | 按工作区分组浏览归档、批量取消归档、**按规则自动归档**（每日核查 + 试运行预览） | **部分覆盖**（规则是"不活跃 N 天"与"每工作区保留最近 M 条"，非目录消失） | 「自动归档默认关闭，可配置「**不活跃超过 N 天**」与「**每个工作区保留最近 M 条**」，每日核查一次，执行前可试运行预览清单」；「自动归档只调用 dsh 公开的 `archiveSession`」 |
| **dsh-session-manager（hkkz9522）** | [npm](https://www.npmjs.com/package/dsh-session-manager) · [hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) | 9504 | 删除/归档/**跨工作区移动**/预设迁移 + 标签、备注、批量 | **部分覆盖**（全手动；"移动至工作区"可把会话搬回重建后的目录，属迂回解法） | 「DeepSeek Harness session manager: delete, archive, **move across workspaces**, migrate presets, favorites, …」（03b 已收录） |
| **dsh-session-plus** | [npm](https://www.npmjs.com/package/dsh-session-plus) · [SZMY-haruhi/dsh-session-plus](https://github.com/SZMY-haruhi/dsh-session-plus) | 454 | 侧栏归档目录、恢复到**原槽位**、删除、修改并分支 | **部分覆盖**（手动） | 「恢复：从归档集合拿掉；**工作区 `sessionIds` 槽位官方归档时本来就没拆**，所以回到原位置」；「归档走官方 `workspaces.archiveSession`」；「设置页大管家（导出、暂停、压缩、**AI 重命名**）我不做」 |
| **dsh-archive-restore（liulifu）** | [npm](https://www.npmjs.com/package/dsh-archive-restore) · [liulifu/dsh-archive-restore](https://github.com/liulifu/dsh-archive-restore) | 未找到（8–9 月新包） | 设置页列已归档会话（含标题）、多选**一键恢复**并自动重启 GUI | **部分覆盖**（只有恢复侧，且是手动触发） | 「归档只是把会话 id 记入 workspace 域的 `archivedSessionIds` 集合（`~/.dsh/storages/workspace.json`）；会话日志与工作区槽位原样保留」；「原名 `dsh-archive-manager`（npm 已被占用），发布名改为 `dsh-archive-restore`」 |
| **dsh-chat-archive-manager** | [npm](https://www.npmjs.com/package/dsh-chat-archive-manager) · [zhaoliang233/dsh-plugins](https://github.com/zhaoliang233/dsh-plugins) | 1354 | 设置页「归档管理」：**按工作区**浏览、批量归档、恢复、二次确认永久删除 | **部分覆盖**（按工作区分组，但全手动） | 「在设置页提供「归档管理」页面：**按工作区浏览**、批量归档、恢复，以及需要二次确认的永久删除，不额外创建 Workspace」 |
| **dsh-easy-archive** | [npm](https://www.npmjs.com/package/dsh-easy-archive) · [bainianlaoyao/easy-archive](https://github.com/bainianlaoyao/easy-archive) | 218 | 工作区侧边栏行内**两击归档**（一次变红确认，再点归档） | **部分覆盖**（纯手动，仅归档） | 「two-step inline archive on workspace sidebar rows — one click arms a red confirm, the second archives」 |
| **dsh-ui-session-archive** | [npm](https://www.npmjs.com/package/dsh-ui-session-archive) · [gitee: past-events-sifenruwu/deepseek-harness-electron](https://gitee.com/past-events-sifenruwu/deepseek-harness-electron) | 815 | 侧栏入口 + 归档面板：查看、恢复、打开、永久删除 | **部分覆盖**（手动） | 「Session archive manager for the dsh web GUI: sidebar entry plus an archive panel to view, restore, open, and permanently delete archived sessions.」 |
| **dsh-archive-vault** | [npm](https://www.npmjs.com/package/dsh-archive-vault) · [Britneycode/dsh-archive-vault](https://github.com/Britneycode/dsh-archive-vault) | 748 | 设置面板查看、恢复、永久删除归档会话 | **部分覆盖**（手动） | 「dsh 插件：在设置面板中查看、恢复与永久删除归档会话」 |
| **dsh-archive-manager-plus** | [npm](https://www.npmjs.com/package/dsh-archive-manager-plus) · [MS666666/dsh-archive-manager](https://github.com/MS666666/dsh-archive-manager) | 297 | 列出归档会话 + 真正的删除（含会话文件与记账清理） | **部分覆盖**（手动；删除侧） | 「归档管理：在设置页列出已归档会话，并提供真正的删除（含会话文件与记账清理）。」 |
| **@michengai/dsh-archive-manager** / **@leitaoy/dsh-archive-manager** / **@gamegeek-saikel/dsh-archive-manager** | [MichengAI](https://github.com/MichengAI/dsh-archive-manager) · [leitaoyu](https://github.com/leitaoyu/dsh-archive-manager) · [Saikel-Orado-Liu](https://github.com/Saikel-Orado-Liu/dsh-archive-manager) | 171216 / 379 / 680 | 三个同名的"归档会话管理"实现（第三方是**永久删除**侧） | **部分覆盖**（手动） | 「NPM-installable DSH Web plugin for managing archived sessions.」（Saikel 版描述为「Permanent session deletion for the DSH Web GUI … while DSH's own archive UI keeps owning archived sessions」） |
| **dsh-session-kit** | [npm](https://www.npmjs.com/package/dsh-session-kit) · [ltxlong/dsh-session-kit](https://github.com/ltxlong/dsh-session-kit) | 3178 | 会话管理菜单、归档管理、轮次级删除、重新生成、记忆/任务管理 | **部分覆盖**（手动，打包） | 「会话管理菜单、归档管理、轮次级删除、重新生成、记忆管理、任务管理、话题导航。」 |
| **dsh-session-enhance** | [npm](https://www.npmjs.com/package/dsh-session-enhance) · [Tinger-X/dsh-session-enhance](https://github.com/Tinger-X/dsh-session-enhance) | 912 | 归档与预览、保证物理删除、**拖拽跨工作区移动会话**、分支树 | **部分覆盖**（手动；跨工作区拖拽可搬回重建目录） | 「archive & preview sessions, guaranteed physical delete, **drag-and-drop session moves between workspaces**」 |
| **@achasoft/dsh-advanced-sidebar** | [npm](https://www.npmjs.com/package/@achasoft/dsh-advanced-sidebar) · [navid-kianfar/dsh-advanced-sidebar](https://github.com/navid-kianfar/dsh-advanced-sidebar) | 774 | 右侧 dock：git、终端、文件浏览器、**Archive and Delete** | **部分覆盖**（手动） | 「…background tasks, Open in, **Archive and Delete**, in a resizable dock beside the conversation」 |
| **@dsh-undo/rollback-archive** + **@dsh-undo/client-rollback-settings** | [npm](https://www.npmjs.com/package/@dsh-undo/rollback-archive) · [23swccp/dsh-undo](https://github.com/23swccp/dsh-undo) | 298 / 278 | 单向归档清单、只读查看、墓碑式隐藏 | **部分覆盖**（"one-way archive listing"，明确无恢复） | 「Session archive capability: **one-way archive listing**, read-only viewing, and tombstone hiding」 |
| **dsh-conversation-manager** | [npm](https://www.npmjs.com/package/dsh-conversation-manager) · [lanlandeli/dsh-conversation-manager](https://github.com/lanlandeli/dsh-conversation-manager) | 257 | 归档控制、活动详情、血缘、输出文件清理 | **部分覆盖**（手动） | 「A safe, accessible session manager for DeepSeek Harness with **archive controls**, activity details, lineage, and output-file cleanup.」 |
| **dsh-archive（占名）** | [npm](https://www.npmjs.com/package/dsh-archive) · [dushaobindoudou/dsh-archive](https://github.com/dushaobindoudou/dsh-archive) | 33 | 把冷会话归档为压缩包——**占名，未发布** | **未实现**（不可用） | 「Archive cold sessions to compressed bundles - **name reserved; first release in development**.」 |
| **dsh_session_folders** | [EugeneVl/dsh_session_folders](https://github.com/EugeneVl/dsh_session_folders) | 未找到 | 侧栏单层会话文件夹：**按工作区分组**、拖拽/右键移动、**归档与恢复**，服务端持久化 | **部分覆盖**（按工作区组织 + 手动归档/恢复，不感知目录消失） | 「为网页侧边栏提供单层会话文件夹——**按工作区分组会话**，支持拖拽或右键菜单移动、**归档与恢复**，数据在服务端持久化。」 |
| **dsh-workspace-kit** | [ice5kysl/dsh-workspace-kit](https://github.com/ice5kysl/dsh-workspace-kit) | 2372 | 工作区优先侧栏：**软归档/恢复**、每工作区图标与强调色、拖拽排序、⌘K Spotlight | **部分覆盖（恢复侧最接近）**（手工软归档；状态在浏览器侧） | 「提供**软归档/恢复**、每工作区 SVG 图标与强调色、拖拽排序与标题/路径/会话内容搜索」（03b 已收录并补充了 localStorage 细节） |
| **dsh-workspace-menu** | [0imzero/dsh-workspace-menu](https://github.com/0imzero/dsh-workspace-menu) | 未找到 | 主页工作区/会话增强菜单：置顶、重命名、资源管理器打开、**归档**、分叉、复制、新窗口 | **部分覆盖**（手动归档入口） | 「DSH 主页工作区/会话增强菜单：置顶、重命名、资源管理器打开、**归档**、分叉、复制、新窗口打开。」 |
| **dsh-archive-manager（Neumannzc）** | [Neumannzc/dsh-archive-manager](https://github.com/Neumannzc/dsh-archive-manager) | 未找到 | 美化版归档管理设置页：**按工作区分组**展示归档会话，悬停取消归档 | **部分覆盖**（手动） | 「美化版归档管理设置页：**按工作区分组**展示归档会话，悬停即可取消归档，附相对时间显示。」 |
| **dsh-delete-chat** | [npm](https://www.npmjs.com/package/dsh-delete-chat) · [youqu68/dsh-delete-chat](https://github.com/youqu68/dsh-delete-chat) | 563 | 设置页 list/archive/unarchive/永久删除 | **部分覆盖**（手动） | 「Session manager for DeepSeek Harness: list, archive, unarchive and permanently delete sessions from a settings page.」 |
| 官方 `@deepseek-ai/dsh-workspace` | [npm](https://www.npmjs.com/package/@deepseek-ai/dsh-workspace) · [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 1876835 | `archiveSession` / **`unarchiveSession`** / `pin`；`Workspace.status()` → `'ok' \| 'missing-dir'` | **官方底座，且明确不做②** | 见下节 C.2 的原文引用 |
| 官方 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` | [npm](https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-settings-unarchive-sessions) | 46073 | 官方归档集合设置页，每行一个 Unarchive | 官方底座 | 「Archived-session settings page: the registry-global archive set with one Unarchive action per row」；注意 `@linxin666/dsh-session-archive` README 称「DSH `0.1.7-alpha.2` **no longer mounts** the official `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` page」 |

### B.3 工作区管理类（③，与①②交叉但本身不解决①②）

| 名称 | 来源链接 | 能力 | 覆盖①②? |
|---|---|---|---|
| dsh-session-manager（mzzsfy 分叉） | [mzzsfy/dsh-plugin](https://github.com/mzzsfy/dsh-plugin) | 历史输入浮层（四范围搜索）、对话分叉与家族版本切换 | 无关（会话增强） |
| dsh-workspace-combiner | [ninglovegithub/dsh-workspace-combiner](https://github.com/ninglovegithub/dsh-workspace-combiner) | 把文档锚点目录与多个代码仓库组合进同一会话，注入路径索引并同步沙盒可写目录 | 无关 |
| dsh-workspace-scope | [Ri0n72Y/dsh-workspace-scope](https://github.com/Ri0n72Y/dsh-workspace-scope) | 按工作区启停 Skill 与 MCP | 无关 |
| dsh-workspace-sort | [Moonshile/moonshile-dsh-plugins](https://github.com/Moonshile/moonshile-dsh-plugins) | 侧栏工作区按最近活动每日排序一次 | 无关 |
| dsh-better-workspace | [KannaKuron/dsh-better-workspace](https://github.com/KannaKuron/dsh-better-workspace) | 工作区层级树（`/` 即虚拟分组）、重命名即时重排、右键操作 | 无关（组织而非归档） |
| dsh-plugin-busy-workspace | [baifagg/dsh-plugin-busy-workspace](https://github.com/baifagg/dsh-plugin-busy-workspace) | 把含运行中会话的工作区提到最前并高亮 | 无关 |
| dsh-harness-ui | [jianjianzhu/dsh-harness-ui](https://github.com/jianjianzhu/dsh-harness-ui) | 整页控制台：从 `pluginInventory`/`pluginManager` 读已装 bundle，并**列出 GitHub 搜索 API 中 `topic:dsh-plugin` 公开仓库**的插件市场 | 无关，但**它自己实现了 GitHub topic 检索**，是 A 节检索通道的现成参考实现 |
| dsh-session-reference / dsh-title-index | [gtaifu/dsh-title-index](https://github.com/gtaifu/dsh-title-index) | 标题索引加速（`@` 提及的标题快照走 (mtime,size) 索引） | 无关（性能） |

---

## C 需求①②的生态占位判定

### C.1 需求①（总结对话 → 自动命名）：**已被做透，不建议重做**

- **判定：覆盖，且有多家竞争。** 直接做"读整段对话 → LLM 总结 → 写回标题"的至少 4 个：`@weibaohui/dsh-smart-title`、`dsh-session-title-pattern`、`lyxx999/Automatic-session-renaming-for-dsh`、`dsh-titlecraft`；另有 `@klarkxy/dsh-current-title`（跟随最新任务）。
- **最接近/最完整的是 [`@weibaohui/dsh-smart-title`](https://github.com/weibaohui/dsh-smart-title)**：唯一把"每轮结束对**用户消息 + 助手回答**的完整转写"写成第一卖点的，并且把工程细节（节流、长会话冻结、同题静默、失败重试、手动改名保护、启动回填、标题模型可单独指定）全部覆盖。注意它**必须**接管官方 `first-prompt` provider，因为 `session-title` 服务只允许一个提供方——这与 `00-lead-verified-facts.md` §1.1 的官方契约完全吻合。
- **次要最接近**：`dsh-session-title-pattern`（`日期｜类型｜主题`，按 N 条重算）。
- **可行的差异化空间**（若仍要做）：多语言/命名规范由工作区或 profile 统一约束；按成本预算选择廉价标题模型并给出用量统计；把标题写入与 `@` 提及索引联动（`dsh-title-index` 已占此位）。但**核心能力已被占满**。

### C.2 需求②（工作区目录消失 → 自动归档；目录回归 → 自动恢复）：**真空白，且官方语义与之冲突**

**（a）没有任何插件覆盖。** 我检索了 npm `keywords:dsh-plugin` 下的 archive 类（`total: 6578` 的检索空间）、awesome 列表全量条目、GitHub topic 与多个第三方市场，**未找到**任何以"工作区目录消失"为触发条件自动归档、并在目录回归后自动恢复的实现。现有实现全部落在两类：

1. **手动归档/恢复**（占绝大多数）：`dsh-session-plus`、`dsh-archive-restore`、`dsh-chat-archive-manager`、`dsh-easy-archive`、`dsh-ui-session-archive`、`dsh-archive-vault`、`dsh-session-kit`、`EugeneVl/dsh_session_folders`、`ice5kysl/dsh-workspace-kit`、`0imzero/dsh-workspace-menu`、`Neumannzc/dsh-archive-manager` …
2. **按时间/数量自动归档**（只有两个，且判据都不是目录存在性）：
   - [`@linxin666/dsh-session-archive`](https://github.com/zhu1090093659/dsh-web)：`autoArchiveDays`，判据是「**last-activity time, never creation time**」。
   - [`dsh-plugin-archive-manager`](https://github.com/qinyre/dsh-plugin-archive-manager)：判据是「不活跃超过 N 天」与「每个工作区保留最近 M 条」。

**最接近的两个**：`@linxin666/dsh-session-archive`（已有完整的"自动维护 + 批量归档/恢复 + 预演 + 调度"框架，只差把判据换成目录存在性）与 `dsh-plugin-archive-manager`（已有"按规则自动归档 + 每工作区保留"的工作区维度）。二者都是**可直接改造的骨架**。

**（b）官方语义与②直接冲突（这是②真正的难点）。** `@deepseek-ai/dsh-workspace` 的 `README.zh.md` 原文：

> - 「会话加入它运行目录所在的项目……**目录无法校验的会话——没有记录目录，或目录被移动、删除——无法加入，保持 Ungrouped。**」
> - 「项目不再需要时移除它：它离开列表，而其文件夹、文件与会话历史绝不受影响——这些会话变成 Ungrouped。**之后再次添加同一目录会从空项目开始，不会带回旧会话。**」
> - 「**外部变更延迟可见**——如果另一进程删除或损坏目录，项目只能在**下次刷新或重启后**反映出来。」
> - 「**移除绝不删除数据**……而**会话删除与文件夹移除是彼此独立且尚未提供的功能**。」
> - 「归档与取消归档执行**不同**的会话校验——恢复只是从归档集合中移除 id，因此会话已不存在的条目仍能取消归档……而 `archiveSession` 会拒绝既非实时也未持久化的会话。」

⇒ 三条硬约束：
1. 官方**不会**因为目录消失而归档，也不会因为目录回归而恢复；目录消失只让会话"保持 Ungrouped"。
2. 目录**重新加回**在官方看来是一个**全新的 workspace 身份**，不会自动带回旧会话。所以②的"恢复对应对话"必须由插件自己建立 **目录路径 → 会话 id** 的映射（不能依赖官方 workspace 记账）。
3. 目录的外部变更**延迟可见**（下次刷新/重启），所以检测目录存在性需要插件自己轮询或监听，不能指望官方推送。

**（c）②可行的实现路径（已被官方 API 完整支撑）：**
- 检测侧：`Workspace.status()` 在 0.2.0-rc.2 中返回 `'ok' | 'missing-dir'`（实测源码：`return (await stat(this.record.path)).isDirectory() ? "ok" : "missing-dir";`），可直接作为触发判据。
- 归档侧：`ctx.workspaceRegistry.archiveSession(sessionId)`（有活跃工作时会抛 `WorkspaceActiveSessionError`；`{ stopActivity: true }` 可跳过检查并先写归档再派发停止事件）。
- 恢复侧：**官方有 `unarchiveSession(sessionId)`**，无需直写存储。归档集合是 registry-global 的 `archivedSessionIds`（持久化在 `~/.dsh/storages/workspace.json`），归档会在同一次写入中**清除置顶**，且不改变 workspace 成员关系。
- 注意「活动检查与归档写入不是一个原子步骤」：在提供方作答与持久化写入之间开始的回合会在隐藏状态下运行（暴露面约一个模型步）。

### C.3 与 `03b-ecosystem-npm.md` 的差异与更正

| 项 | 03b 的说法 | 本报告核实结果 |
|---|---|---|
| ①最完整的实现 | 未列出 `@weibaohui/dsh-smart-title`（仅列了 pattern / titlecraft / 官方 all-prompts） | **遗漏**。`@weibaohui/dsh-smart-title`（1147/mo）是唯一以"每轮对**用户消息 + 助手回答**完整转写做总结"为第一卖点、且工程细节最全的实现，应为①的首选结论 |
| ①的其他遗漏 | — | `@klarkxy/dsh-current-title`（928/mo）、`@hanxu131/dsh-autotitle`（335/mo）、`smart-session-title`（1690/mo，但**无关①**，只看首条 prompt）、`lyxx999/Automatic-session-renaming-for-dsh`、`fengb3/dsh-session-icons` |
| ②其他遗漏 | — | `dsh-session-plus`、`dsh-archive-restore`、`dsh-chat-archive-manager`、`dsh-easy-archive`、`EugeneVl/dsh_session_folders`、`dsh-ui-session-archive`、`dsh-archive-vault`、`dsh-archive-manager-plus`、`@michengai/@leitaoy/@gamegeek-saikel` 三个同名 archive-manager |
| 官方归档是否 one-way | 「官方归档是 **one-way（无 unarchive API）**」 | **不成立（需更正）**。`@deepseek-ai/dsh-workspace` 有 `unarchiveSession(sessionId)`（`lib/index.js` 实测），且官方有 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` 取消归档设置页。③恢复侧可直接用官方 API，不必像 03b 建议的那样直写 `storageDomain` |
| ②触发判据 | 「`Workspace.status() === 'missing-dir'` 的检测 → 自动 archiveSession」 | **一致且已独立复核**：`status()` 确实返回 `'ok' \| 'missing-dir'` |
| 官方通道 | 未覆盖 | 本报告 A 节补齐：分发= npm registry（+npmmirror 回退）、约定=`dsh.bundle`、接口=npm search API / GitHub topic / `plugin_manager` / 社区市场 |

> 下载量口径提示（沿用 03b 并复核）：官方 `@deepseek-ai/*` 包月下载在 150 万–250 万量级，明显被镜像/CI 放大，**不可与社区包横向比较热度**；社区包之间量级可比。个别社区包（如 `@michengai/dsh-archive-manager` 171216、`@linxin666/dsh-session-archive` 120182）显著高于同类，可能同样受 CI/镜像影响，**仅作弱信号**。

---

## 附：本次检索中「未找到」的项

- 未找到任何以"工作区目录消失"为触发条件的自动归档插件。
- 未找到任何"目录回归后自动恢复会话"的插件。
- 未找到官方远程插件 marketplace / registry JSON 端点（官方确认为 npm registry）。
- `lyxx999/Automatic-session-renaming-for-dsh`、`fengb3/dsh-session-icons`、`dsh-enhance-tool`、`0imzero/dsh-workspace-menu`、`Neumannzc/dsh-archive-manager`、`EugeneVl/dsh_session_folders`、`dsh-archive-restore` 的**仓库 star 数**：本次未取到，未编造。
