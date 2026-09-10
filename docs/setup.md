# Setup: fixture inspection or real tasks

## No-account fixture path (tested on macOS arm64)

Install Node 24+ and Git first. This pass used Node **24.18.1**, npm **11.16.0**; exact installed package versions come from `package-lock.json`. No real Codex executable was used during this pass. The older real app-server check used Codex 0.153.2; package download inputs currently pin 0.153.4 in `scripts/prepare-tools.mjs`. Those are historical/proposed compatibility facts, not a fresh provider verification.

```sh
git clone https://github.com/benjamin05wilson/codex-fleet.git
cd codex-fleet
export ELECTRON_CACHE="$PWD/.cache/electron"
export npm_config_cache="$PWD/.cache/npm"
npm ci
npm run demo:verify
# Optional graphical product capture (macOS/Windows):
npm run demo:capture
```

PowerShell equivalents for the cache variables:

```powershell
$env:ELECTRON_CACHE = "$PWD/.cache/electron"
$env:npm_config_cache = "$PWD/.cache/npm"
npm.cmd ci
npm.cmd run demo:verify
npm.cmd run demo:capture
```

`npm ci` installs locked dependencies and may download native prebuilts. Electron may download its runtime on first use. macOS postinstall restores the executable bit on the **repo-local** node-pty spawn helper. If a compatible native prebuild is unavailable, node-pty needs Python and a C/C++ toolchain (Xcode command-line tools on macOS, Visual Studio C++ build tools on Windows, compiler/make on Linux). Package building additionally downloads the pinned, checksum-verified tools; macOS icon generation needs Swift/iconutil. None of that packaging work is required for the headless verifier.

The verifier uses five explicit fixtures with Node's structured test events and requires exactly the expected executed test per scenario. Reports include commit, dirty-tree flag, platform, Node, commands, selected identities and raw JSON Lines. Output is `.fleet/demo-verification/`; process durations include test startup/teardown and are not throughput measurements. Model-call/intervention counters are not instrumented or reported. `tests/demo-verifier.test.mjs` deliberately selects a nonexistent name and asserts failure.

Capture creates a fresh source repository, SQLite/worktrees and Electron profile beneath `.cache/fixture-tour-*`, binds an OS-selected available port on **127.0.0.1**, and removes owned state on completion/error. Its 60-second Electron child bound prevents an abandoned window from keeping the fixture alive. It saves `docs/evidence/{worktree-review,scoped-knowledge}.png` and `fixture-task.json`. The project and conversation visibly say FIXTURE. Codex and Writer are both set to explicit checked-in fixture paths **before any project is added**. Missing fixture binaries fail the capture; no PATH/provider fallback is selected. It starts `createApp` directly and never reads remembered daemon settings. Do not run real-provider smoke commands for this path.

## Real Codex tasks (separate, not executed in this pass)

After the clone/dependency steps, install the deliberately selected CLI locally:

```sh
npm install --prefix .cache/codex @openai/codex@0.153.4
export FLEET_CODEX_BIN="$PWD/.cache/codex/node_modules/.bin/codex"
"$FLEET_CODEX_BIN" login
npm run build
npm start
```

Use `.cache/codex/node_modules/.bin/codex.cmd` and `$env:FLEET_CODEX_BIN` in PowerShell. Open the loopback URL printed by the daemon (default `http://127.0.0.1:4317`), or run `npm run desktop` for native browser/terminal UI. Keep CLI and Fleet configuration compatible; the pinned packaging version has not been revalidated against an account in this pass. Windows requires Codex's native sandbox setup; see the [detailed setup flow](manual.md#windows-setup).

Real setup uses your Codex authentication and may consume account usage. Adding a project can enable the Brain Writer, which sends bounded source excerpts through that account; disable the Writer before indexing if you do not want this. Review project permissions and validation command before approving tasks. Credentials stay with Codex. Source mode stores state in `.fleet`; normal daemon shutdown can leave durable workers alive for reconnection. Do not delete ordinary work data to reset a demo.

`npm run check` runs fixture server/UI tests and a production build. `test:codex` invokes a real CLI sandbox check; `tests/live-session.mjs --run` and `tests/live-team.mjs --run` make real model turns. These are deliberately excluded from the no-account route.
