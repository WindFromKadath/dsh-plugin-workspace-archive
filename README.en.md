# dsh-plugin-workspace-archive

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin: when a workspace folder is deleted or moved away, **archive** the sessions that belong to it; when the same folder comes back, **bring them back** to that workspace — using official APIs only.

中文（主）说明见 [README.md](README.md)。

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
| A session sits in "Ungrouped" but its working directory **is** a registered workspace path | It is attached to that workspace once, at start-up (condition: in no workspace's member list + the directory matches **exactly**; disable with `adoptUngrouped: false`) |

Two rules the plugin always keeps:

- **Sessions you archived yourself are never unarchived**: they only get their grouping back, and stay hidden until you unarchive them.
- **Archive and restore only ever handle sessions it has recorded**: the ledger is written while the plugin runs and the workspace is healthy, and that path never scans by working directory. The one exception is the start-up **adoption** pass (last row above).

## Why this works (the key mechanism)

The ability needs **no file edits at all**: in DSH, "which workspace a session belongs to" lives in a **member list inside the workspace record**, and the official API to append to that list exists (`Workspace.attachSession`).

1. **Grouping is a roster, not a field inside the log.** A session log stores its own working directory; which workspace it is shown under is the member list of the workspace record — so changing the group means changing the roster, which the official API allows.
2. **Attaching validates exactly one condition, and that condition already holds.** `attachSession` reads the session header's `cwd` and requires it to **normalize to exactly** the workspace path, refusing otherwise. An orphan session in "Ungrouped" has a `cwd` that already equals that path, so the official call accepts it — and re-validates it for us, which makes attaching to the wrong workspace impossible by construction.
3. **Being off the roster is a hole the official code leaves itself.** DSH groups existing sessions by `cwd` only on the **first** start-up (a one-time bootstrap that writes an initialized marker); workspaces added later never re-claim older sessions. That is the step this plugin supplies.

Moving a session **from one workspace to another** is *not* possible this way: it would require changing `cwd` itself, which is stored inside the session log, and no official API rewrites it. See [docs/recon/05-migration-and-multi-folder.md](docs/recon/05-migration-and-multi-folder.md) and [docs/plan-session-migration.md](docs/plan-session-migration.md).

## Requirements

- DSH (DeepSeek Harness) desktop or CLI; developed and verified against `0.2.0-rc.2`.
- Node.js 22.5+ (the host provides it).
- **No runtime dependencies.** The plugin imports nothing outside Node's standard library — on purpose: a plugin loaded through a directory link resolves nested imports by real path and cannot reach the host's packages.

## Install

Three ways, the first one recommended:

1. **From npm (recommended; `0.1.0` published 2026-10-08)**

   ```
   dsh plugin add dsh-plugin-workspace-archive
   ```

   The plugin manager uses the npm registry (official registry, falling back to `registry.npmmirror.com`; both were verified in sync). Pin a version with `dsh-plugin-workspace-archive@<version>`.
2. **From a local checkout** (what this repository's real-machine tests use): link the directory into a profile's `node_modules` and add the package name to the profile manifest. On this machine, `.verify/install-desktop.mjs` does all four steps and can be rolled back with `--uninstall`.
3. **From this repository by commit**: the official plugin manager also accepts a GitHub spec, for example `dsh plugin add github:WindFromKadath/dsh-plugin-workspace-archive#<commit>`.

**A restart is required.** The plugin row and its bundle are fixed at host start-up; HMR never hot-loads them. Configuration defaults live in `resolveConfig` in [src/index.js](src/index.js); a profile patch row can override `dryRun`, `confirmDelayMs`, `pollIntervalMs`, `watch`, `adoptUngrouped` and `adoptDelayMs`.

## Verification

- `npm test` — **48 offline assertions** (tool behaviour, the decision layer, the ledger, real Cordis loading, the adoption selection logic, and the "plugin source must not import host packages" regression).
- `npm run rm-test` — **27 assertions against a real DSH runtime** in a throwaway `DSH_HOME`: create workspace → create two real sessions → delete the folder → assert exactly the right session is archived → put the folder back → assert it is restored and re-attached, while a session archived by the "user" stays archived → delete the registration and re-add it → assert both come back to the group → an ungrouped orphan session is adopted.
- `npm run check` — syntax.

Both suites are re-runnable and never touch a real profile or a real workspace folder. See [MAINTAINER.md](MAINTAINER.md) for the design constraints, adopted decisions and evidence trail.

## Limitations

- **Archive and restore only know sessions they have recorded.** If the delete-and-re-add happens while the plugin is not running, it knows only the last snapshot in its ledger: members present in that snapshot are re-attached, older strays are not (the start-up adoption covers those whose `cwd` still equals the workspace path).
- **Re-attaching is not unarchiving.** `attach` only touches the workspace member table; it never touches the archive set.
- **Adoption runs once** (5 seconds after start-up): an orphan that appears later waits for the next restart.
- **Cross-workspace migration is out of scope**: it would require offline rewriting of the session log, which has no official channel.
- No session deletion, no folder deletion, no cross-machine sync.
- A renamed folder is a different path: attaching re-validates the `cwd`, and the plugin only logs when it does not match.

## License

MIT — see [LICENSE](LICENSE).
