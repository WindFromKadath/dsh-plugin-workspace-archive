# dsh-plugin-workspace-archive

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin: when a workspace folder is deleted or moved away, **archive** the sessions that belong to it; when the same folder comes back, **bring them back** to that workspace — using official APIs only.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## The gap this fills

DSH keeps "folder missing" and "archive" apart on purpose:

- a workspace whose folder cannot be validated — missing, moved, or never recorded — cannot take new sessions, so its sessions fall into **Ungrouped**;
- removing a project keeps its folder and its session history, but **re-adding the same folder starts from an empty project**: the old sessions do not come back.

The plugin supplies the missing link. It never touches `app.asar`, never writes the official `storages/` or `sessions/` files, and keeps its own bookkeeping in a sidecar under the DSH home directory.

## What it does

| Trigger | Result |
|---|---|
| A registered workspace folder is deleted or moved | The sessions **this plugin had recorded** for that path are archived (hidden from the default sidebar view, still reachable under "all conversations") |
| The workspace registration is removed ("Delete workspace") while the folder stays | Treated the same as a disappearance, and archived — otherwise those conversations fall into "no project" |
| The folder or the registration comes back | The sessions this plugin archived are **unarchived**; and **every member recorded in the plugin's ledger** is re-attached to the workspace at that path — including sessions that were **already archived before the disappearance** (typically ones you archived yourself) |

Two rules the plugin always keeps:

- **Sessions you archived yourself are never unarchived.** They only get their grouping back, and stay hidden until you unarchive them.
- **It only ever handles sessions it has recorded.** The ledger is written while the plugin runs and the workspace is healthy; the plugin never scans by working directory to re-claim sessions you deliberately left ungrouped.

## Requirements

- DSH (DeepSeek Harness) desktop or CLI; developed and verified against `0.2.0-rc.2`.
- Node.js 22.5+ (the host provides it).
- **No runtime dependencies.** The plugin imports nothing outside Node's standard library — on purpose: a plugin loaded through a directory link resolves nested imports by real path and cannot reach the host's packages.

## Install

The plugin is not published to npm yet. Two supported ways:

1. **From a local checkout** (what this repository verifies): link the directory into a profile's `node_modules` and add the package name to the profile manifest. On this machine, `.verify/install-desktop.mjs` does all four steps and can be rolled back with `--uninstall`.
2. **From this repository** (documented, not yet verified here): the official plugin manager accepts a GitHub spec, for example `dsh plugin add github:WindFromKadath/dsh-plugin-workspace-archive#<commit>`. Because the plugin has no dependencies, an installed copy behaves like the linked one.

**A restart is required.** The plugin row and its bundle are fixed at host start-up; HMR never hot-loads them. Configuration defaults live in `resolveConfig` in [src/index.js](src/index.js); a profile patch row can override `dryRun`, `confirmDelayMs`, `pollIntervalMs` and `watch`.

## Verification

- `npm test` — 41 offline assertions (tool behaviour, the decision layer, the ledger, real Cordis loading, and the "plugin source must not import host packages" regression).
- `npm run rm-test` — 22 assertions against a **real** DSH runtime in a throwaway `DSH_HOME`: create workspace → create two real sessions → delete the folder → assert exactly the right session is archived → put the folder back → assert it is restored and re-attached, while a session archived by the "user" stays archived.
- `npm run check` — syntax.

Both suites are re-runnable and never touch a real profile or a real workspace folder. See [MAINTAINER.md](MAINTAINER.md) for the design constraints, adopted decisions and evidence trail.

## Limitations

- **Only sessions the plugin has recorded.** If the delete-and-re-add happens while the plugin is not running, it knows only the last snapshot in its ledger: members present in that snapshot are re-attached, older strays are not.
- **Re-attaching is not unarchiving.** `attach` only touches the workspace member table; it never touches the archive set.
- No session deletion, no folder deletion, no cross-machine sync.
- A renamed folder is a different path: attaching validates `cwd === workspace path`, and the plugin only logs when it does not match.

## License

MIT — see [LICENSE](LICENSE).
