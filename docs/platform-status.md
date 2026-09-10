# Platform scope, checks and dated evidence

[![Core checks on main](https://github.com/benjamin05wilson/codex-fleet/actions/workflows/core.yml/badge.svg?branch=main)](https://github.com/benjamin05wilson/codex-fleet/actions/workflows/core.yml) [![Windows checks on main](https://github.com/benjamin05wilson/codex-fleet/actions/workflows/windows.yml/badge.svg?branch=main)](https://github.com/benjamin05wilson/codex-fleet/actions/workflows/windows.yml)

The badges track **main**, not an unmerged PR. Follow [core runs](https://github.com/benjamin05wilson/codex-fleet/actions/workflows/core.yml), [Windows runs](https://github.com/benjamin05wilson/codex-fleet/actions/workflows/windows.yml), or the relevant pull request's checks for the exact commit you intend to use. No static table here certifies a later revision as green.

## What each gate establishes

| Platform | Source / fixture gate | Desktop gate | Packaging boundary |
| --- | --- | --- | --- |
| macOS | Server and React tests, production build, five-scenario fixture verifier | Electron Brain, large graph, native browser/agent smoke | Separate arm64 development packaging command; configured to bundle Node/Codex and use system Git |
| Ubuntu | Same core server/UI tests, build and fixture verifier | No desktop release target | No desktop package offered |
| Windows 11 x64 | Native runtime tests; capability/daemon/store/auth; Brain, blob-reader, worker and terminal lifecycle regressions; UI/build/fixture verifier | Brain, large graph and native-browser smokes | NSIS generation plus package/branding verification; a built installer still needs an actual native launch check |

Both workflows run on pull requests, main pushes and manual dispatch. Server tests have a 90-second per-test deadline. Core check and Windows test steps also have a five-minute ceiling, since a completed test can still leak an event-loop handle beyond Node's per-test timeout. Timeouts fail jobs; there is no force-exit success or swallowed teardown error. Packaging retains its separate job budget.

Development packages are unsigned, and macOS packages are not notarized. No published installer/release was verified for this readiness evidence on **10 September 2026**. Check [releases](https://github.com/benjamin05wilson/codex-fleet/releases) separately from Actions artifacts. Signing is not required for source inspection. Source licence choice and exact-bundle notices remain separate owner/distribution decisions; see [distribution inventory](distribution.md).

## Dated observations — 10 September 2026

These are records, not a substitute for checking a later commit:

- **Local macOS arm64, Node 24.18.1:** the full check after ordered-cleanup changes passed 241 server tests (two Windows-only skips), 113 UI tests and the build. The subsequent indexing/reader change passed 14 focused tests, retaining the 510-file overflow and exact wiki coverage assertions. The saved [fixture report](evidence/verification/report.json) and [product captures](tour.md) independently record clean source commit `36ca3a0` and their exact commands.
- **Parent-confirmed core CI:** commit `f2b11bf` passed both core platforms, including their applicable fixture/desktop gates. Ubuntu job `102958999615` completed after fixture cleanup ordering was repaired. The earlier macOS pass at `e125997` is linked in [run 34502515174](https://github.com/benjamin05wilson/codex-fleet/actions/runs/34502515174).
- **Parent-confirmed Windows evidence:** `e125997` passed native, capability/daemon/store and auth gates, then failed Brain indexing (one overflow timeout and a partial-vs-complete junction assertion). The overflow case passed in the next `f2b11bf` run; the junction assertion still failed. See the earlier [Windows run 34502515224](https://github.com/benjamin05wilson/codex-fleet/actions/runs/34502515224). These failed runs did not establish package or installer-launch success.

## Repairs to trace in source

- `CodexClient.close()` awaits child close/stdio release; auth, discovery and validation await disposal. The capability regression verifies closure before immediate directory removal, without filesystem retries. The exact historical EBUSY handle was not captured; the repaired capability gate subsequently passed on Windows.
- First-use fixtures now close app ownership, SQLite and then the directory. A live-worker regression requires its journal to exist at shutdown entry. Focused fixtures await full engine/Brain drains. This prevents POSIX unlink semantics from deleting active journals before reconciliation.
- Pinned indexing reuses one bounded `git cat-file --batch` process, with object/type/size checks, independent file/byte budgets and binary rejection. Pipes close after rejected frames too. Symlinks/junctions and excluded canonical targets are classified before coverage; deliberate policy exclusions do not make eligible coverage partial. A forced index entry below a link reproduces Windows-style enumeration on every platform.
- MCP deadline tests synchronize expiry with actual HTTP queue entry; watcher tests observe native readiness before asserting a separate edit. Production timeout defaults remain intact.

`IMPLEMENTATION.md` is a historical checkpoint, not the platform contract. Capability checks and fixture tests do not establish hostile-local-user isolation, arbitrary reboot recovery, model quality or exactly-once external side effects.
