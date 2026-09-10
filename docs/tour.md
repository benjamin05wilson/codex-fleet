# A 60-second engineering tour

**Real Fleet execution; fictional project; scripted Codex and Writer output.** No account, real provider or model calls were used. This captioned walkthrough is the useful demo artifact; it is a sequence of actual captures, not a video or a simulated UI mockup. Open the [offline slide viewer](evidence/tour.html) from a clone for Back/Next controls, or read below directly on GitHub.

## 0:00–0:20 — A task becomes reviewable evidence

![Fixture worktree diff and check result](evidence/worktree-review.png)

Fleet created a new Git worktree, launched its deterministic Codex protocol fixture, and recorded the completed turn. The fixture wrote `artifact.txt`. The right pane shows the **real diff** and a passing **real local validation command**. The original source repository stayed unchanged. The result remains in review; nothing was accepted or published. The fixture does not enforce the real Codex sandbox, so the normal product sandbox copy visible in the UI is not sandbox-verification evidence here.

[Task provenance and exact check](evidence/fixture-task.json) · [Reproduce capture](setup.md#no-account-fixture-path-tested-on-macos-arm64)

## 0:20–0:40 — Knowledge has a scope

![Brain current-worktree scope](evidence/scoped-knowledge.png)

The Brain's **Current worktree** view selects the task branch. Amber nodes are working-copy knowledge, not shared merged facts. This graph comes from indexed fixture code/wiki/turn receipts; Writer invocations are scripted fixtures even though the normal UI labels them “calls.” Lexical retrieval excludes other worktrees and stale notes. Follow the [capability/revocation source trail](architecture.md#data-ownership-and-trust-boundaries) to see how lookup permissions are rechecked.

## 0:40–1:00 — Recovery has a boundary

[Five executed fixture scenarios](evidence/verification/report.json) cover surviving-worker reconnection, approved dependencies, finding resolution, terminal ownership and project-isolated context. Each scenario preserves structured test events, exact identity, command and process duration. The recovery scenario checks unchanged worker identity, one attempt and one completion after daemon detach. It does **not** establish reboot recovery, model quality or exactly-once external effects.

[Read one task and three failure paths](architecture.md) · [Current platform status](platform-status.md)

## Reproduce and inspect provenance

```sh
npm run demo:verify
npm run demo:capture
# To save a verification run for publication:
node scripts/verify-demo.mjs --output docs/evidence/verification
```

The saved reports name the source commit they executed, which necessarily precedes the commit containing their generated output. The manifest records capture-source hashes and whether the checkout was dirty before capture. JSON Lines preserve equivalent structured runner output; stderr is retained separately. Paths in verifier output are sanitized to `<repo>`/`<temp>`. There are no model-call/intervention metrics. Durations measure whole test processes.

The screenshots were captured by Electron from the production React build, inspected visually, and kept unaltered. The fixture's repository, SQLite/worktrees and Electron profile were removed after capture. No persistent demo service remains. This is a bounded reproduction command, not a general interactive fixture product mode.
