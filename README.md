# Fleet

A local, Codex-only workspace for running tasks, reviewing evidence, and keeping project knowledge. Version 0.2 introduces the focused desktop/CLI architecture.

## Open Fleet

Requires macOS, Node.js 24+, Git, and an authenticated Codex CLI. The app-server adapter and live sandbox check were verified with Codex CLI **0.153.2**.

```sh
npm ci
npm run build
npm start
```

Open [the local workspace](http://127.0.0.1:4317). Run `codex login` if needed; Fleet reuses that authentication and never asks for an API key.

For the native shell:

```sh
npm run desktop
npm run desktop:package
```

The package is `release/mac-arm64/Fleet.app`. Packaging needs the macOS command-line tools for the reproducible app icon. This local build is unsigned and not notarized; it is not a ready-to-distribute public release.

The desktop starts or connects to an independent daemon. Closing or quitting the desktop does not stop Codex workers. It remembers the connected daemon's data directory for subsequent launches. From a source checkout, `npm start` runs the daemon in the foreground; stopping it detaches surviving Codex workers, and restarting reconnects to their journals. Interactive worktree shells and validation commands are not durable across daemon shutdown.

## The workspace

- Fleet starts on **Home**, with a compact start column and searchable project cards showing real folder paths and branches. Duplicate project names display their folder names without renaming stored projects. **New project** opens folder creation; **Open folder** opens existing-folder setup. **Just a conversation** opens an idle Scratch conversation; earlier scratch conversations remain available in the start column.
- Up to three recent conversations appear below the cards, with your last meaningful conversation first. Empty waiting drafts and generic team placeholders remain accessible inside their workspace but are not promoted on Home. Background reviewer activity does not reorder project cards.
- A permanent horizontal row provides **Home · All projects · individual project tabs**. Home keeps the project-launcher page; All projects shows every visible project and scratch group in the sidebar, while a project tab focuses its own conversations. Extra tabs scroll horizontally, not into a dropdown. Switching scope resets the sidebar filter and preserves unsent drafts. Browsing sessions in All projects mode keeps the full sidebar visible. Project tools live under the separate ellipsis menu. Navigation never queues an agent. Explicit `#session=…` links still open directly into a session; ordinary startup/reload returns to Home.
- **×** closes a project tab only: it does not delete the project, stop agents or clear drafts. Closing the active project tab returns Home. Closed tabs stay closed across reloads; **+** reopens them or offers New project/Open folder. Opening a project from Home also restores its tab. Home and All projects cannot be closed.
- One collapsible sidebar groups conversations under your projects and Scratch. The project-name menu contains memory, workflows, security, attention and settings; there is no separate navigation rail.
- **Tools** opens Files, Preview, Worktree shell or Changes & checks beside the conversation. There are no permanent tool tabs. Changed-file counts open the diff directly. Smaller windows stack the tool beneath the conversation. File views are read-only, include untracked edits, and apply sensitive-path exclusions and content redaction; these checks are heuristic, not a secrets guarantee.
- Approved reviewers work in the background. Findings, failed/stale assessments and exhausted review budgets remain visible; routine readiness/progress badges stay hidden. Reports and team controls remain accessible through Changes & checks and project settings.
- Persistent project/session selection, unsent session instructions, follow-ups and the selected Files/Preview/Changes tool. Shell attachment always requires a deliberate click.
- **+ New conversation** (`⌘N` / `Ctrl+N`) opens an idle conversation directly in the selected project, or a new Scratch space when no project is selected. There is no setup form and no model call until you send an instruction. New conversations are independent; they do not silently resume the team's Developer.
- The composer shows **Read only** or **Edits allowed**. Click it to change permissions/model explicitly and optionally remember them for future conversations. Settings are locked during execution, shells, previews and managed reviews. Read-only is the initial default. Enter sends; Shift+Enter adds a line. Sending uses your Codex allowance.
- `⌘K` / `Ctrl+K` searches session titles, workflow objectives, project notes and committed file names. File previews are read-only; sensitive path patterns are excluded.
- Long event histories load in pages. The browser uses server-sent notifications with reconnect replay, plus a slow reconciliation refresh.

There are no fabricated sessions, successful checks, costs or activity. Open your own Git repository by path, or use the desktop folder picker. **Check repository** reads Git status and package scripts without executing them; detected check commands are suggestions you must select. Example creation has been removed. Existing example histories are retained and can be shown from Settings.

The session model selector discovers the installed Codex model catalogue through `model/list`; Settings reads the actual authentication type through `account/read`. Discovery failures are shown explicitly, with the installed default/manual model entry still available. Workflow templates and limits come from the daemon, not duplicated UI constants. `FLEET_CONCURRENCY` configures the daemon scheduler (1–16).

## Starting a project

Start in **Scratch space** when you do not have a project yet. Each scratch conversation creates its own empty local repository under Fleet's data directory; it does not read another project or your home folder as its workspace. The execution worktree and Codex thread are created only when you send the first instruction. Scratch is persistent, not an auto-deleted temporary chat. There is no automatic promotion/export to a named project yet.

Add the folder, open a conversation, and describe the outcome directly to Codex. Names, check commands and optional team permissions live under **Advanced options** during folder setup or in project settings later. The guided-build and persistent-Developer task APIs remain compatible with earlier clients, but are not separate everyday creation paths in the desktop interface.

Choose **Add a project** to create a new folder or open an existing one. Creating a project asks for its parent location, folder name and approval to initialise local Git. It creates an empty starting commit; no GitHub account, remote, template installation or global Git configuration is needed. Existing targets are never overwritten, and new projects cannot be nested inside another repository.

Existing non-Git folders and Git folders with no commits can be initialised with the same explicit approval. Fleet does **not** add or commit existing files, including staged files. Commit only the files you want agents to use before starting work; uncommitted files remain in the source folder and are absent from isolated worktrees. Inspecting a folder is read-only. If setup fails, files are left in place with an error explaining where it stopped.

Alternatively choose **Review files for a working copy**. Select the starting files and explicitly approve the copy. Fleet creates a separate source repository under its local data directory, with the original path recorded in Settings; it does not change the original folder or its Git history, and does not automatically copy accepted work back. This also supports a selected snapshot of uncommitted files from an existing repository.

Snapshot review excludes common dependency/build/private directories, Git metadata/attributes, sensitive filenames, symbolic links, detected credentials and non-UTF-8/binary files. It is limited to 2,000 entries, 1 MB per file and 20 MB scanned content. Custom `.gitignore` rules are not interpreted; review the explicit file list. The credential check is heuristic, not a guarantee. Source changes invalidate approval; imported bytes come from the verified scan rather than a later unchecked source copy.

## Working preview

An implementation session’s **Preview** tab starts a local app command you enter and explicitly approve. Use the app’s documented command, bound to `127.0.0.1`, and specify its port. Fleet does not automatically install dependencies. A successful HTTP response enables the embedded preview; unavailable ports, startup failures and server output are visible. Apps that block framing may not render in the embedded view.

Preview commands run as your local user **outside the Codex sandbox**, with network access and possible file side effects. The UI explains this before execution. The preview URL is restricted to a loopback port distinct from Fleet, the frame cannot read Fleet’s origin, and no app content is served under Fleet’s own origin. The command itself must bind locally; Fleet does not rewrite or sandbox it. An owned process group is stopped on request, after 15 minutes, or on daemon shutdown. Preview holds the worktree lease, blocking coding/review/acceptance until stopped, and invalidates previous validation.

Server output can become an **unsent fix-request draft**, tagged as untrusted evidence. This does not capture the embedded browser’s JavaScript console or automatically fix anything. Browser error capture, automatic stack scaffolding and guided export back to an imported source are future work.

## Project teams

During project setup, approve a **Developer + Security + Verification** team, optionally including **Memory**. Existing projects can enable a team in Settings. Enabling launches a read-only assessment in separate, persistent Codex threads when committed files exist. Empty projects allocate their team without model calls or assessment budget use; the first assigned developer task starts implementation, and reviewers wake after it completes. It never starts implementation without a task from you.

- New tasks can use the persistent Developer or an independent session. Only explicitly assigned developer tasks get workspace-write permissions. After acceptance, the developer retains its Codex thread but gets a new worktree/session record, preserving the accepted history.
- Completed implementation turns wake Security and Verification. They inspect the same snapshot concurrently in read-only mode; Fleet-managed writers, shells, acceptance and validation wait for the reviewers to finish. External filesystem edits cannot be locked out and invalidate review results.
- Review reports contain scope/coverage, concrete findings, file/line references, severity, confidence and suggested verification. Failed or malformed reports are failures, never a clean pass. Reports are shown in Review, with failed/stale rounds in Attention.
- **Send findings for a fix** is a human-triggered action within the original task scope. There is no autonomous repair loop. A current completed review is required for acceptance while the team is enabled; reported findings require an explicit acknowledgement with a reason.
- Optional Memory assesses initial project facts and proposes notes after accepted work. Proposed Markdown is stored with source/snapshot provenance and remains excluded from context until human approval. Notes from an accepted-but-unmerged task branch may remain stale until its source commit is integrated.
- Approve 1–20 rounds and 1–15 minutes per assessment (defaults: 5 rounds, 5 minutes). Initial assessment and memory passes count as rounds. Later change rounds normally invoke two reviewers. These bound turn counts and wall time, **not tokens or currency**. The global daemon concurrency limit still applies.
- Pause watchers to stop assessments and prevent further automatic reviews; this also disables the team acceptance gate, explicitly shown in Settings. Manually assigned coding work is not stopped. Renewing approves another five rounds. Failed/stale reviews require a manual request; restart reconciliation never creates duplicate completed rounds.

The scheduler stays local and wakes sessions on completed task events, not every keystroke. Reviewers use the documented app-server `thread/resume` and `turn/start.outputSchema`; they do not require native Codex TUI handoff. Read-only filesystem permissions are enforced by Codex; no credential isolation or complete security certification is claimed. Repository text and model findings are untrusted context.

## Sessions and execution

Each new implementation starts in its own Git worktree at committed source HEAD. Uncommitted source edits stay in the source repository. Runs use read-only or workspace-write permissions, with workspace network access disabled and no unattended permission escalation.

The daemon launches detached execution owners using the documented [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server). Each worker has a unique attempt identity, restricted-permission configuration and append-only redacted event journal. Reconnection ingests events transactionally with a cursor, avoiding duplicate turns and usage counting.

A dead worker becomes interrupted; Fleet does not automatically repeat its potentially side-effectful work. Resume is explicit. A machine reboot does not preserve a live process. Execution attempts have a 30-minute limit.

**Native Codex TUI handoff is not enabled.** The capabilities endpoint reports this explicitly. The Shell tool is a real PTY-backed **worktree shell**, not Codex's TUI and not recorded output pretending to be interactive. It runs as your local user, acquires an exclusive Fleet write lease, and invalidates validation. Another client cannot take its controls without the owner closing it. Close the shell before resuming an agent or accepting changes. Other tools outside Fleet are not governed by this lease.

## Review and security

Review combines the diff, validation and security findings. Acceptance commits on the task branch only; Fleet does not merge into the source branch, push, deploy or publish a PR.

Validation uses app-server `command/exec` with an explicit workspace sandbox. Missing or unavailable sandbox execution is reported as unavailable, never silently replaced with full access. The API supports a separately explicit `allowUnsandboxed: true` decision, which is audited.

Checks are bound to the command and complete content snapshot, including binary and untracked files. Further changes invalidate the evidence; changing files during checks fails that run. The truncated display diff is not used as the acceptance fingerprint.

Sentinel watches worktree changes with debouncing, plus periodic reconciliation, and observes command events after dispatch. It uses targeted heuristics—not comprehensive SAST or command/network interception. It:

- Records redacted findings, locations, reasons for waivers and resolution history.
- Rechecks after fixes and reopens previously resolved matches that return.
- Reports skipped coverage; an unscanned file does not count as clean.
- Blocks acceptance on unresolved high-severity findings.
- Flags declared-scope drift. Approved workflows pause for scope changes; ordinary sessions retain advisory scopes.

Fleet is a trusted-user local tool, not a multi-user service or a safe place to run arbitrary untrusted repositories. Git hooks are disabled for Fleet-managed Git operations. User shell commands, Git configuration, repository tools and external services can have broader effects. Redaction covers selected credential formats and is not a guarantee that all secrets are detected.

HTTP binds to loopback. Host/origin checks, mutation tokens and persistent idempotency keys protect the local API. Do not expose the port publicly. Electron uses a sandboxed renderer, context isolation, no Node integration, denied browser permissions and no arbitrary privileged IPC, following the [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Project Brain

The Brain's left **Files** sidebar lists the project's Markdown notes alphabetically, with independent search, a new-note shortcut and a vault note count. Click a file to open its reader alongside the graph; graph selection highlights the corresponding file. The sidebar toggle beside the title hides/shows it. On narrow windows it overlays the graph and closes after a successful file selection. New auto-written notes appear through the existing refresh loop, and file navigation retains the unsaved-edit guard.

Graph motion uses a bounded force simulation: nodes settle on opening, connected notes respond to dragging, and force changes reheat the layout from its current positions. **Display → Animate** replays the settling animation; **Pause animation** freezes it. This is a layout replay, not a chronological note-history playback. Animation stops when settled, pauses in hidden tabs and follows the system's reduced-motion preference. Panning, zooming and note access still work with reduced motion enabled.

Open a project and click **Brain** in the top bar. Each project has its own Obsidian-compatible Markdown vault. The graph opens full-width with a plain dark canvas, compact neutral nodes, labels underneath, faint straight links and purple hover/focus accents. Nodes retain their pixel scale when the viewport resizes or the reader opens. Click a node to open its Markdown reader/editor; drag nodes/the canvas, zoom, or use Fit graph. The top-right settings panel starts open with Filters, Groups, Display and Forces collapsed; its X hides it and the settings icon reopens it. Search, note-type filters, orphan visibility and Local graph help explore connections. Optional group colours distinguish human notes, generated inventory, session receipts and unapproved proposals. Display sliders change label fading, node size and link thickness; force sliders adjust the layout. Restore defaults resets these view controls without changing notes. Older source revisions remain identified in node tooltips and the reader. Graph edges come only from actual wiki links between existing notes, not inferred relationships. The graph is bounded to 250 notes; the complete vault remains accessible in Notes view.

Fleet's existing inventory watcher checks committed repository changes every 20 seconds, and finished sessions write factual receipts with their objectives, changed files, outcomes and provenance. Brain checks for new/changed notes every eight seconds while open. **Refresh inventory** requests an immediate source inventory update, not a model run. This does not continuously interpret unsaved code or automatically approve architectural conclusions. Human-written decisions are preserved; optional Memory-agent proposals still need approval. Opening the graph makes no model calls.

Create notes with **New note** and connect them with `[[Note title]]`. Duplicate names are rejected in the creation UI, unsaved note edits are kept locally, and changing notes while editing requires saving or cancelling first. **Copy vault path** lets you open the same folder in Obsidian itself.

Context selection ranks local notes against the task, uses a 12,000-character budget, and excludes stale notes and unapproved proposals. Pin or exclude notes using the Brain's Context menu. Session details show the exact stored context selection used for the run.

Proposals can be approved explicitly; Fleet does not silently promote inferred decisions to authority. Automatic semantic decision extraction and embeddings are not implemented. Project context is isolated; there is no automatic cross-project sharing.

## Approved workflows

Create a plan from Implement, Investigate or Review templates. Edit its objective, tasks, scopes and dependencies, save it without execution, then approve it once.

Defaults are three concurrent executions, at most five tasks, one corrective retry per task, and 30 minutes per execution attempt. Overlapping declared write scopes are serialized. Dependencies may proceed from checked results within the same approved workflow, without human acceptance of every intermediate task. Dependency handoff copies verified changed files into a separate worktree; symbolic-link handoffs require manual review.

Coding workflows require a configured validation command. They run checks automatically, stop when limits or permission/scope assumptions are exceeded, and propose completion. Human acceptance closes the associated work items. Schedules, unattended triggers, external publishing and recursive delegation are not implemented.

Earlier manually created missions remain accessible separately for compatibility.

## CLI and local API

```sh
npm run fleet -- doctor --json
npm run fleet -- projects --json
npm run fleet -- list --json
npm run fleet -- new PROJECT_ID --title "Investigate" --task "Explain the parser" --start
npm run fleet -- resume RUN_ID --task "Address the failing test"
npm run fleet -- stop RUN_ID
npm run fleet -- review RUN_ID --checks
npm run fleet -- review RUN_ID --accept
npm run fleet -- attach RUN_ID
npm run fleet -- workflow run PROJECT_ID --file plan.json
npm run fleet -- workflow run PROJECT_ID --file plan.json --approve
```

`attach` opens the selected session in the local web interface. It does not claim native terminal takeover. `new` defaults to read-only; use `--write` for a coding task and `--scope src,tests` for declared paths. Install/link the package if you want a bare `fleet` command; global installation is not performed automatically.

Desktop and CLI use the same client in `shared/client.mjs`. Public contract types are in `shared/contracts.ts`; `GET /api/capabilities` exposes API version 1 and availability. `GET /api/stream` supports event IDs and replay; mutations can provide an `Idempotency-Key`. A pending request surviving a crash is not blindly re-executed.

| Variable          | Purpose                                 |
| ----------------- | --------------------------------------- |
| `FLEET_PORT`      | Daemon port; defaults to 4317           |
| `FLEET_DATA_DIR`  | Explicit data directory                 |
| `FLEET_CODEX_BIN` | Codex executable; defaults to PATH      |
| `FLEET_NODE_BIN`  | Node 24+ executable for desktop startup |
| `FLEET_URL`       | CLI daemon URL; loopback HTTP only      |

## Data and upgrades

The source checkout stores SQLite, worktrees, worker journals, Markdown vaults and verification reports under `.fleet/`. Packaged first launches without a remembered daemon use the desktop user-data directory.

Versioned SQLite migrations back up legacy databases using SQLite's backup-safe export before upgrading. Legacy active runs must finish or be explicitly stopped first. Existing projects, run history, task branches, worktrees and notes are retained. Newer unsupported database versions are refused. Do not delete `.fleet` as a troubleshooting step.

No Line Command databases, work repositories or source branches are imported or rewritten.

## Verification

```sh
npm run check
npm run test:codex
npm run demo:verify
node tests/live-session.mjs --run
node tests/live-team.mjs --run
```

- `check`: backend lifecycle/safety tests, interface interactions and production build.
- `test:codex`: the real installed app-server allows a write inside an isolated test worktree and rejects one outside it. **No model call.**
- `tests/live-session.mjs --run`: explicit opt-in **real model** check of task creation, isolated edits, recorded output, sandbox validation and unchanged source. Uses one model turn and retains its temporary repository for inspection; never accepts or publishes changes.
- `tests/live-team.mjs --run`: explicit opt-in, up to six real model turns across three distinct threads, verifying initial assessments, resumption, coding, structured reviews, sandbox checks and unchanged source. Retains a verification report in its temporary directory. Not included in the default test suite.
- `demo:verify`: five reproducible fixture scenarios—reconnection, workflow dependencies, finding resolution, terminal ownership and ranked context. Writes measured durations to `.fleet/demo-verification.json`. These are system tests, **not model-performance or hiring-impact benchmarks**.

Tests create their own temporary repositories and remove only those fixtures. Browser QA additionally covers the live session view, combined review, terminal rendering, navigation and responsive layout.

See [implementation status](IMPLEMENTATION.md) for release boundaries and outstanding acceptance work.
