# 开发项目协作规则

- 接手先确认用户当前要求，读取 README.md 和 tasks.csv 中相关任务行，再查看实际代码与必要的运行结果。历史总结中的方法判断要回查依据。
- README.md 记录目标、运行方式和已采纳取舍；tasks.csv 记录当前任务；实现与验证以代码和真实产物为依据。
- 本轮围绕一个明确的用户场景工作，保持改动可审查。范围、验收标准或关键取舍需要改变时，先说明影响，由用户决定。
- 作者视角记录作者自己的理解和疑点。可对照真实产物指出错误并建议修改，作者理解后回写；不得从任务完成推断作者已经掌握。
- 关键路径改变时，简述依据变化、选择和影响。存在作者学习目标时，用一个具体场景检查相关理解，避免只提供长篇总结。
- 在授权范围内自行完成可撤销的实现、相关检查和普通错误修复，不逐步索取“继续”确认。
- `done` 必须有场景验证证据，并填写对应版本和日期。未执行的检查、环境不可用或无法重现都标为待验证；不要通过削弱验收场景来凑通过。
- 优先更新已有文件和同一任务行。默认在对话中交接；新建 Markdown 要有独立交付用途，并从入口链接。
- 临时想法不写成已采纳决策；不要删除尚有引用的历史依据。多个执行者同时修改任务表时，先明确一位汇总者。
- 结案报告：实际改动、验证证据、达到的验收条件、剩余问题、下一步。

## 本项目的环境事实（写作与调试时直接用，不必重新勘查）

- 工作区 = `<repo>`；插件最终要能被本机 **DSH Desktop 0.2.0-rc.2** 装载。
- DSH 官方源码打包在 `<app>\resources\app.asar`（asar 内根 `dsh/`）。**只读**取用：
  `node .recon\asar.mjs --list|--print|--grep|--tree|--extract <asar> <asar内路径> [extra]`。
  官方包自带 `README.zh.md`，是优先于代码的契约来源。
- 运行时 profile：`$env:DSH_HOME\profiles\desktop\`（`cordis.yml` 装载清单、`cordis.patch.yml` 覆盖层、`package.json` 的 `dsh.profile.bundles`）。**只读**，除非用户明确要求做插件安装/启停。
- 运行时数据：`~/.dsh/sessions/--<slug>--/<sessionId>/session.v4.jsonl.zstd`（zstd **多帧**拼接，按 magic `28 b5 2f fd` 切帧）、`~/.dsh/storages/workspace.json`（`archivedSessionIds` 等）。**只读**。
- 插件约定：`package.json` 必须声明 `dsh.bundle.patch`；客户端半用 `dsh.client`；兼容性用 `engines.dsh`。DSH 没有远程插件市场，分发即 npm registry。
- 参考先例：`<branch-repo>`（`dsh-plugin-branch`，纯 JS 无构建链、79 项冒烟断言）——**只读**，可抄工程约定，不要改动它。

## 危险操作边界（越界前必须先问用户）

- 不删除、不改名、不移动**任何真实工作区目录**；场景验证一律用一次性临时目录。
- 不写 `~/.dsh` 下官方 `storages/`、`sessions/` 里的任何文件；归档/恢复只走 `ctx.workspaceRegistry` 官方 API。本插件**自己的** sidecar 只允许写在 `$DSH_HOME/workspace-archive/`（`dshHomePath('workspace-archive', …)`）。
- 归档前必须先落 sidecar 台账；恢复只处理台账交集，**绝不能**批量 `unarchive` 用户手动归档的会话。
- 不修改 `app.asar`、不修改 profile、不给官方包打补丁。
- `.recon/` 是只读勘察用的一次性脚本与 asar 展开目录（已 gitignore）；不要把结论留在那里，结论进 `docs/`。
