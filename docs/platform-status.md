# Current platform status — 10 September 2026

Source execution, desktop validation, package generation and publication are separate gates. CI results below were confirmed by the parent integration agent; local evidence was executed on macOS arm64.

| Platform | Source checks | Desktop smoke | Packaging / publication |
| --- | --- | --- | --- |
| macOS | Core checks passed at `e125997`; newer `f2b11bf` core check also passed | `e125997` passed brain, large-graph and native-browser smokes; actual fixture captures are tracked | No package rerun locally; unsigned arm64 package design exists; no published release |
| Ubuntu | `f2b11bf` passed all core checks and demo verification (job `102958999615`) after fixture cleanup ordering was repaired | Core portability target, not a desktop release | No desktop package offered |
| Windows 11 x64 | `e125997` passed native, capability/daemon/store and auth gates; later Brain indexing tests failed. Batched blob reads and link-policy coverage fix added; native rerun pending | Full latest-run acceptance pending | Packaging was not reached in the failed run; installer launch and publication unverified |

[macOS passing run 34502515174](https://github.com/benjamin05wilson/codex-fleet/actions/runs/34502515174) · [Windows run 34502515224](https://github.com/benjamin05wilson/codex-fleet/actions/runs/34502515224) · [Latest workflows](https://github.com/benjamin05wilson/codex-fleet/actions).

## Local evidence and current repairs

The last full local `npm run check`, after ordered-cleanup changes, passed **241 server tests**, skipped two Windows-only tests, passed **113 UI tests** and built the product. The subsequent indexing/reader change passed **14 focused tests**, including the unchanged 510-file overflow scenario and exact wiki coverage assertions. Saved fixture reports/captures identify their own earlier clean source commit; they are not presented as new-commit platform CI evidence.

- **Resource ownership:** `CodexClient.close()` awaits child close and stdio release. Auth, metadata discovery and validation await disposal; app close drains discovery. The capability regression verifies actual child/stdio closure before immediate directory removal without retries. The original EBUSY handle was not captured, but the repaired gate subsequently passed natively on Windows.
- **Linux fixture cleanup:** `first-use.test.mjs` previously registered recursive removal before app shutdown. One fixture owner now closes the app, SQLite and then the directory. A live-worker regression requires its journal to exist at shutdown entry. Focused fixtures await complete engine/Brain drains. Ubuntu `f2b11bf` subsequently passed checks/demo.
- **Windows indexing:** pinned snapshots now use one lazy, bounded `git cat-file --batch` process instead of a process per blob, preserving object/type/size checks, file/byte limits and binary rejection. Owned pipes close even after a rejected frame. Symlinks/junctions and excluded canonical targets are classified before coverage; intentional policy exclusions no longer make the eligible index “partial.” A forced index entry below a link reproduces Windows-style descendant enumeration on all platforms. Full-content and complete-coverage assertions were retained.
- **Timing regressions:** the MCP test triggers its test-controlled deadline only after real HTTP work reaches the queue; the native watcher test observes a readiness probe before asserting a separate edit. Production timeout defaults and behavior remain intact.

## Required gates and limits

Both workflows run for pull requests, main pushes and manual dispatch. Server tests use a 90-second per-test deadline, matching the existing Windows lifecycle gate. Core check and Windows test steps also have a five-minute CI ceiling: a completed test can still leak an event-loop handle beyond Node's per-test timeout. Timeouts fail jobs; no force-exit success or swallowed teardown failure is used. The full job retains its separate packaging budget.

Windows must pass the new reader/indexing regressions, remaining suites, package generation and package/branding verification. A generated installer additionally needs an actual native launch check before claiming launch support. Development packages remain unsigned and macOS is not notarized. macOS packages are configured to bundle Node/Codex and use system Git. Signing is not a source-readiness prerequisite; no public installer download is claimed.

`IMPLEMENTATION.md` is a historical checkpoint, not the current platform contract. Source licensing is still pending the owner; see [distribution scope and outstanding notice inventory](distribution.md).
