# 提交前隐私检查（本项目副本）

本目录是「AI 协作与项目开发」库 `02-隐私与发布/` 模块在**本项目里的副本**：检查脚本 `Invoke-PrivacyCheck.ps1`、公共规则 `privacy-policy.json`，以及两个可选的 Git Hook 模板 `hooks/`。复制时间 2026-10-07。

复制到项目**不等于**启用 Hook、修改 Git 配置或批准发布。当前状态：**脚本可用，Hook 未启用**（`git config --local --get core.hooksPath` 为空，`.git/hooks` 里只有样例文件）。

需要 PowerShell 7.2 或以上版本与 Git。脚本只读本地 Git 索引与对象：不联网、不改文件、不提交、不推送、不改写历史。

## 日常怎么跑

在本目录（仓库根）执行：

```powershell
# 日常：只检查已经暂存、将进入本次提交的文件，以及当前实际署名
pwsh -NoProfile -File .privacy-tools\Invoke-PrivacyCheck.ps1 -Repo . -Mode Staged -Policy .privacy-tools\privacy-policy.json

# 完整暂存快照
pwsh -NoProfile -File .privacy-tools\Invoke-PrivacyCheck.ps1 -Repo . -Mode Index -Policy .privacy-tools\privacy-policy.json

# 首次公开、发布版本或推送新分支前：检查全部本地可达历史
pwsh -NoProfile -File .privacy-tools\Invoke-PrivacyCheck.ps1 -Repo . -Mode History -Policy .privacy-tools\privacy-policy.json
```

| 退出码 | 含义 | 下一步 |
|---:|---|---|
| 0 | 当前自动检查没有阻断项或待人工处理项 | 完成人工检查后再提交 |
| 1 | 发现凭据模式、私人路径、私人标识或不合规署名等阻断项 | 先修复再检查 |
| 2 | 有普通邮箱、二进制附件、超限文件或其他待人工确认内容 | 核查并记录准确例外后再检查 |
| 3 | 配置、Git 读取或环境出错，检查未完成 | 修复运行条件；不能当作通过 |

## 规则文件

`privacy-policy.json` 从模块的 `privacy-policy.example.json` 复制而来，已按本项目填写：

- `allowedCommitEmails`：GitHub noreply（`294740142+WindFromKadath@users.noreply.github.com`）与保留示例邮箱。**本仓库本地署名已于 2026-10-07 设为该 noreply**（此前是全局身份，见下方"当前待处理"）。
- `allowedPublicEmails` / `reviewedBinaryFiles`：本仓库目前没有公开文献联系邮箱，也没有需要登记的人工审查二进制文件，均为空。
- `maxFileBytes`：10 MiB。

**不要**在这些字段里加入希望隐藏的私人邮箱。额外的私人标识（真实姓名、私人邮箱、旧机器名等）放在**仓库外**的 JSON 数组文件里，仅按会话指定：

```powershell
$env:PRIVACY_TERMS_FILE = '<仓库外的私人标识文件>'
pwsh -NoProfile -File .privacy-tools\Invoke-PrivacyCheck.ps1 -Repo . -Mode Staged -Policy .privacy-tools\privacy-policy.json
```

## 本项目的实际结果（2026-10-07）

| 模式 | 结果 | 说明 |
|---|---|---|
| `Staged`（日常） | **1 项**，且是工具自身误报 | 提交前逐次跑，只覆盖本次暂存内容 |
| `Index`（全快照） | **1 项**，同上 | 38 个文件版本 |
| `History`（全部历史） | **1 项**，同上 | 104 个历史文件版本；本机路径 / 用户主目录 / UNC **0 处**、真实用户名 **0 处**、旧私人邮箱 **0 处** |

处理过程：先把文档、脚本、测试夹具里的本机标识统一脱敏（映射表放在**仓库外**），再按知识库「泄露后的处理与验证」流程**改写全部本地历史**（全量 bundle 备份 → 受控副本 `filter-branch` → 回收 → 清旧对象），并把仓库本地署名设为 noreply。完整记录见 [VERIFICATION.md](VERIFICATION.md)。

> 首次实跑（脱敏前）的原始输出是 Index 103 行 / History 142 行，保存在仓库外的受控位置，用于对照。

## 已知误报

1. **脚本把自己标红**：脚本被纳入扫描范围时，`Index` / `History` 会把 `.privacy-tools/Invoke-PrivacyCheck.ps1` 自身报为 `absolute-or-user-path`（其 UNC 检测分支匹配到自己的正则字面量）。规避：日常用 `Staged`；需要干净的全量扫描时从模块目录运行脚本（`<模块目录>\tools\Invoke-PrivacyCheck.ps1`）。
2. **`home` 作为路径段被误判**：「用户主目录」分支会命中任何以斜杠包住 `home` 的文本段（例如本项目一次性验证装置里的临时目录名）。那不是用户主目录。

## 可选：提交拦截 Hook

`hooks/commit-msg` 与 `hooks/pre-commit` 只是**模板**，当前**未启用**。确需启用且不会覆盖已有 Hook 时：

```powershell
git config --show-origin --get core.hooksPath   # 先看现状
git config --local core.hooksPath .privacy-tools/hooks
```

两个 Hook 的任何非零结果都会阻止提交，包括"待人工确认"和"检查未完成"。`--no-verify` 可绕过部分本地 Hook；网页版编辑和 CI 不会自动执行它们。新克隆仍须显式启用。

## 覆盖边界（不要当成"已证明没有隐私问题"）

"没有命中"只说明**所执行检查的范围内**没有发现候选项。以下内容仍需人工核查：图片像素、PDF 正文、Office 备注与隐藏内容、Notebook 输出中的嵌入图像、编码或加密的内容、压缩研究数据、LFS 实际对象、子模块，以及 GitHub 上的讨论与缓存。超过 `maxFileBytes` 的文件不会被读取。

完整的模块说明与流程见「AI 协作与项目开发」库的 `02-隐私与发布/`（README、提交前检查清单、泄露后的处理与验证、tools/使用说明）。
