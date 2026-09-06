# Browser control trial — 6 September 2026

## Decision

Prefer **agent-browser for Fleet's first agent-controlled browser prototype**. Both candidates completed the tested interactions; agent-browser had materially lower warm CLI latency on this machine. Keep Playwright in consideration for generated regression tests and richer debugging output. This is a small local trial, not a universal browser-agent benchmark or proof of production readiness.

No browser integration was added to Fleet. Its application dependencies, desktop process and daemon were not changed by this trial.

## Setup and method

- agent-browser **0.36.0**, verified native macOS ARM64 Rust executable.
- @playwright/cli **0.1.19**.
- Both launched **Google Chrome 152.0.7977.76**, headless, with separate empty browser sessions. Same executable, but each tool supplies its own default launch flags.
- Packages installed locally under ignored `build/browser-bakeoff/`, not globally or in Fleet's root package.json. No extra LLM service, API key or model calls.
- One local fixture with fictional accounts/orders, delayed DOM updates, duplicate button labels, a same-origin iframe, an open Shadow DOM, a file input, an HTML dialog, popup link and intentional HTTP 503/console error.
- The assistant inspected snapshots, selected references from those observations and issued CLI commands. It did not bypass the UI by writing fixture state or calling its handlers directly.
- Additional real-app check: opened Fleet's Home in isolated browser sessions and filtered projects for `etsy`. No project/session creation, terminal selection, deletion or other app mutation.
- Command runner records wall time, exit status, raw stdout/stderr and linked snapshot contents. Timings exclude the assistant's reasoning and orchestration latency. Output measurements are UTF-8 bytes, **not model tokens**.

## Functional observations

| Check                                               | agent-browser                           | Playwright CLI                                         |
| --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Fill and submit fictional sign-in                   | Pass                                    | Pass                                                   |
| Find delayed search results                         | Pass; explicit text wait                | Pass; refreshed snapshot after initial Searching state |
| Select correct row with duplicate Select buttons    | Pass                                    | Pass; emitted scoped reusable locator                  |
| Fill and submit same-origin iframe form             | Pass through snapshot references        | Pass through iframe references                         |
| Check open-Shadow-DOM checkbox                      | Pass                                    | Pass                                                   |
| Attach dummy upload.txt                             | Pass, direct upload command             | Pass, open chooser then upload                         |
| Inspect and confirm fictional modal                 | Pass                                    | Pass                                                   |
| Open, inspect and return from popup tab             | Pass; popup became active automatically | Pass; explicit tab selection                           |
| Read intentional console error                      | Pass                                    | Pass, includes source location                         |
| Identify intentional failed request                 | Pass, HTTP 503                          | Pass, HTTP 503 and detail commands available           |
| Full-page screenshot at 1280px width                | Pass                                    | Pass                                                   |
| Separate session does not inherit fictional sign-in | Pass                                    | Pass                                                   |
| Fictional sign-in survives page reload              | Pass                                    | Pass; reloaded through dashboard                       |
| Operate Fleet's real React project search           | Pass                                    | Pass                                                   |

Both initial full-page screenshots were **1280 × 1580**, with identical SHA-256:

`2ba571cdf50cfb746c1c2cd9972ea28657b0f75a608fecc3717fe1fab6bc3dd4`

Snapshots and screenshots verified the intended outcomes, not merely successful command exit codes. No interaction recovery was required for the core tasks. Playwright's first delayed-search snapshot still showed Searching; the next inspection showed the results.

## Repeated measurements

Five warm samples per operation/tool, alternating which tool ran first each round. Same populated fixture, 1280 × 900 viewport, no dashboard open during sampling. Fill repeatedly sets the same existing search-field value. Screenshots are full-page.

| Operation            | agent-browser median (range) | Playwright CLI median (range) |
| -------------------- | ---------------------------- | ----------------------------- |
| Full snapshot        | **32 ms** (31–35)            | 142 ms (141–154)              |
| Fill field           | **30 ms** (28–82)            | 143 ms (142–182)              |
| Full-page screenshot | **82 ms** (73–99)            | 193 ms (185–198)              |

Full snapshot output was 2,329 bytes versus 2,653 bytes: about **12% smaller**, not evidence of a universal 90% token reduction. Agent-browser also has a smaller interactive-only snapshot mode; it was used for navigation but not substituted for full snapshots in this comparison.

Cold launch was sampled once: agent-browser 1,354 ms; Playwright 1,239 ms. Do not infer a launch-speed winner from one sample. One Playwright diagnostic click took 6,180 ms but succeeded; other fixture clicks were typically around 700 ms. These commands do different post-action work, so the differences do not measure the Rust language alone.

## Live view and handoff

- agent-browser: connected to its session-specific WebSocket stream, received seven viewport frames over approximately three seconds, first frame after 24 ms, and visually checked the saved JPEG. This was a mostly static page, **not an FPS or end-to-end latency benchmark**. The probe emitted an error event during intentional connection shutdown after successfully receiving frames; no streaming interruption was observed during collection.
- Playwright: started an isolated local dashboard server, selected the trial session, enabled interactive mode and used its Reload control. Verified the live preview screenshot and the resulting reload through a subsequent CLI snapshot. The first immediate screenshot preceded visible frame delivery; a later screenshot showed the page.
- Playwright's dashboard was inspected with an additional agent-browser test session. This checks the dashboard as a user-facing control surface; it is not an independent Playwright streaming performance measurement.
- Neither shared-cursor arbitration nor two agents concurrently controlling the same tab was tested.

## Security and integration findings

1. Playwright's post-login snapshot contained the fictional password in plaintext. agent-browser's snapshot masked the password field. Both commands still received the dummy password as an argument, and Playwright printed the fill code too. **Neither this trial nor masking establishes credential safety.** Fleet should keep secrets out of agent command output, histories and traces.
2. agent-browser automatically selected the new popup; Playwright left the original tab selected. Fleet must explicitly track tab ownership, not assume the active tab remains unchanged.
3. agent-browser's modal snapshot focused only on the modal. Playwright's snapshot retained surrounding page content. Smaller output can help focus; fuller context can help debugging.
4. Project/session separation passed only a basic local-storage test. It is not an adversarial security-isolation test.
5. Do not expose Fleet's privileged Electron renderer or daemon through unrestricted browser debugging. A production integration needs authenticated, project-scoped control, protected internal origins, resource limits and explicit user/agent handoff.

Not tested: real authentication/SSO, cross-origin iframes, closed Shadow DOM, canvas/WebGL, anti-bot sites, large web applications, crash recovery, browser-restart persistence, arbitrary hostile pages, durable permission enforcement or Electron embedding/CDP compatibility.

## Local evidence and reproduction

All trial dependencies and raw artifacts remain under `build/browser-bakeoff/` (gitignored):

- `fixture.mjs`: test HTTP server; prints its allocated loopback URL.
- `run.mjs`: timed CLI command wrapper; reads linked Playwright snapshot files for inspection.
- `sample.mjs`: five-round sampler. Requires the same populated sessions and current observed references; it is not a standalone automatic end-to-end replay.
- `stream.mjs`: bounded stream frame collection probe.
- `artifacts/commands.jsonl`: commands, timings and observed outputs.
- `artifacts/measurements.json`: repeated sample summaries.
- `artifacts/agent-browser.png`, `artifacts/playwright.png`: identical full-page captures.
- `artifacts/agent-browser-stream.jpg`, `artifacts/playwright-dashboard-ready.png`: live-view evidence.

Run the fixture, then use `node run.mjs LABEL ab --session UNIQUE_NAME ...` or `node run.mjs LABEL pw -s=UNIQUE_NAME ...`. Inspect new snapshots before selecting references: recorded reference IDs and ports are not guaranteed across reruns. Use empty profiles and dummy data. Close each named test session individually; do not use global close-all/kill-all commands.

References: [agent-browser](https://agent-browser.dev/), [Playwright CLI](https://github.com/microsoft/playwright-cli), [agent-browser security limitations](https://agent-browser.dev/security).
