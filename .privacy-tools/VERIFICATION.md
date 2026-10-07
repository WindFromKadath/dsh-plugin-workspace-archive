# 泄露后的处理与验证记录（本仓库）

处理日期：2026-10-07　处理人/公开别名：WindFromKadath

**处理类别**（公开版只记类别与结论，原始值留在受控证据中）：

| # | 类别 | 说明 |
|---|---|---|
| 1 | 本机绝对路径 | 文档与脚本里写死的本机盘符路径（应用安装目录、全局 npm 目录、用户主目录等） |
| 2 | 本机真实用户名 | 若干勘察文档与 `AGENTS.md` 里出现的 Windows 用户名 |
| 3 | 会话目录 slug | 由本机路径折叠而成的 slug 形态（等价于本机目录布局信息） |
| 4 | 提交署名邮箱 | 12 个历史提交的作者与提交者使用了**私人邮箱**（知识库要求 GitHub noreply） |

**不含凭据**：隐私检查未命中任何令牌、密码、私钥或含凭据的连接串；未发现 `.env`、凭据文件或原始 AI 会话记录被跟踪。

**处理范围**：本仓库**全部本地可达历史** + 当前工作树。

## 1. 处理步骤

1. **全量备份**：`git bundle create <受控备份目录>/workspace-archive-pre-rewrite.bundle --all`，并用 `git bundle verify` 校验；备份留在**仓库外**的受控位置。
2. **受控副本里改写**：`git clone --no-hardlinks` 到仓库外副本，在副本中执行
   `git filter-branch --env-filter <noreply 署名> --tree-filter <脱敏脚本> --tag-name-filter cat -- --all`。
   脱敏脚本与映射表放在**仓库外**（`<受控备份目录>/scrub.mjs`），对旧版本可重复执行；映射表包含真实标识，**不进仓库**。
3. **副本内核验**（前置条件，不通过则停止回收）：全部提交署名 = noreply；提交数不变；**HEAD 的 tree 与改写前逐字节一致**；全部历史里盘符路径 / 用户主目录 / UNC **0 处**、真实用户名 **0 处**、旧邮箱 **0 处**。
4. **回收到原仓库**：从副本 fetch 改写后的分支 → `reset --hard` → 删除副本临时引用 → 分支由 `master` 更名为 `main`。
5. **清旧对象**：删除 `refs/original/*` → `git reflog expire --expire=now --all` → `git gc --prune=now`。

## 2. 验证结论（本地）

| 项目 | 结果 |
|---|---|
| 提交数 | 14（改写前后一致） |
| 全部提交署名 | 仅 `294740142+WindFromKadath@users.noreply.github.com` |
| 全部历史里的本机路径 / 主目录 / UNC | **0 处**（`git grep` 覆盖全部 `--all` 可达提交） |
| 全部历史里的真实用户名 | **0 处** |
| 旧私人邮箱 | **0 处** |
| HEAD 的 tree | 与改写前一致（`56e65ae…`，逐字节） |
| 旧提交编号 | 本地对象库中**已不可解析**（`git cat-file -e` 报 `could not get object info`）；引用只剩 `main`；`git fsck --unreachable` 无输出 |
| 隐私检查（模块目录运行脚本） | `Staged` / `Index` / `History` 均**只剩工具自身 1 项已知误报**（见下） |
| 测试 | `npm test` **41/41**；`npm run rm-test` **22/22** |

## 3. 验证结论（上传后回读）

| 位置/范围 | 有权限访问结果 | 未登录访问结果 | 结论与待办 |
|---|---|---|---|
| 新仓库与默认分支 | `gh api` 回读：`visibility=public`、`default_branch=main`、GitHub 识别许可证为 **MIT**、topics 与 description 已写入 | 受限沙箱下未登录 HTTPS 请求取不到 TLS 凭据（`Authentication failed`），**未能**在本地完成未登录核验 | 公开可见性由 API 结论支持；如需逐条未登录核验，请在浏览器直接打开仓库页 |
| 远端 `main` | 提交数 **14**、HEAD 与本地 `main` **一致**、作者/提交者邮箱为 noreply | — | 一致 |
| 被替换的旧隐私提交 | 旧编号**从未推送**（本仓库是改写完成后才创建并首次推送的） | 同上 | 远端不存在旧内容 |
| 旧标签 / 附件 | 无标签、无 release 附件 | — | 不适用 |
| 活动记录 / PR / Fork | 新建仓库，无 Issue/PR/Fork | — | 不适用 |

## 4. 残留与限制（不要当成"绝对没有隐私"）

- **工具自身 1 项已知误报**：`.privacy-tools/Invoke-PrivacyCheck.ps1` 第 109 行的 UNC 检测分支匹配到自己的正则字面量，因此 `Index` / `History` 无法归零。日常用 `Staged`；需要干净的全量扫描时从模块目录运行脚本（本记录的结果就是这么得到的）。详见 [README.md](README.md) §已知误报。
- 检查范围**不包含**：图片像素、PDF 正文、Office 备注与隐藏内容、编码或加密内容、LFS 实际对象、GitHub 缓存与讨论。本仓库当前没有二进制附件与 LFS 文件。
- 未登录网页核验受本机沙箱限制未完成（见上表），不影响 API 结论。
- 旧的脱敏前历史仍存在于**仓库外的受控 bundle 备份**中；备份用于必要时回查，**不要**从它推送任何分支。

## 5. 受控证据位置（仓库外，不入库）

- 改写前全量备份：`<受控备份目录>/workspace-archive-pre-rewrite.bundle`
- 脱敏脚本与映射表：`<受控备份目录>/scrub.mjs`
- 改写脚本与运行输出：`<受控备份目录>/rewrite-history.ps1`
- 隐私检查报告原文：`<受控备份目录>/pa-index.txt`、`pa-history.txt`
- 改写前的旧提交编号只存在于上述受控位置，**不写入本仓库任何文件**。
