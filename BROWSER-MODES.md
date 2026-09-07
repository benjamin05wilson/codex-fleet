# Fleet browser: native only

## Current product behavior

Fleet Desktop now opens `WebContentsView` directly from **Tools → Browser**. There is no Chrome/headless selector, streamed view, “try native” switch or fallback. Missing desktop support explains that an updated desktop app is required; startup errors stay in the native browser UI. Closing returns to its own start form and clears its temporary session. Project switching tears down the previous native session; opening a new one still requires an explicit click.

**Manual only:** chat browser control is not implemented for this renderer. The product daemon creates no Chrome controller and provides no browser connection to new chat turns. Retired start/control/share/agent/frame endpoints return HTTP 410, including for stale clients; browser state advertises native desktop-only support and no agent capability. Worker instructions no longer direct users to a removed sharing button. The legacy binary is no longer bundled. Historical controller code/tests remain for reference through explicit test dependency injection, not a runtime flag or product fallback.

Checks: `npm run check`; `node tests/live-native-browser.mjs --run --ui` exercises the actual `ProjectBrowser` entry, native page, resize, close confirmation and return to native setup. Native failure, absent bridge, project switching, reopening, stale API calls and lack of daemon agent connections have regression coverage. Applying this to an already-running desktop/service requires restarting them; no active user browser was automatically closed during implementation.

The sections below record earlier experiments and measurements, not currently available browser modes. Their old launch/share instructions are historical.

## Desktop native rendering preview

### Section-specific scrolling investigation

`node tests/live-native-browser.mjs --run --public --scroll-profile --repeat-scroll` scrolls four Shopify sections twice in an isolated native window. It records actual scroll positions, page animation-callback gaps, long tasks, long animation frames and GPU feature status. It never instruments the user's page. These are **main-thread callback measurements, not physical display frame times or input-to-monitor latency**; native scrolling can continue separately from page callbacks, and lazy layout can change the requested section positions.

With the original cache-disabled configuration, cold runs showed intermittent 150–917ms callback gaps, including a ~796ms Shopify event handler and a separate ~480ms layout interval. A repeat pass in the same page had p95 callback gaps of 17.4–17.7ms across all four sections, with one 66.6ms maximum gap. GPU compositing, rasterization and video decoding were enabled. This points to first-visit section work as a substantial contributor, not proof that Fleet adds no overhead or that a particular graphics backend is responsible.

The preview now enables HTTP caching in its unique **in-memory** partition; it still does not persist browser state. Closing or failed startup explicitly clears HTTP cache as well as storage. A real Electron fixture failed before the change (two server requests for the same fresh cacheable asset) and passed afterward (one request), and verifies the session has no storage path and zero HTTP cache after close. This avoids redundant transfers; it is **not a verified fix for first-visit rendering stalls**. No pixel-density reduction, animation removal, graphics flags or automatic pre-scrolling are applied to user pages. An already-running preview needs a relaunch to pick up the change; the user's preview was not restarted during this investigation.

The cache-enabled public run still showed a 232.5ms cold callback gap and a 165.8ms warm hero gap. Warm p95 values were 17.2–17.7ms, with the two lower sections having no callback gaps above 17.7ms. Run-to-run variability prevents attributing scroll improvement to caching. The 1080p hero videos advanced 192–193 decoded frames in eight seconds with zero decoder drops; the screenshot remained 2480×1600. For the memory-only partition semantics, see [Electron's session documentation](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options).

### Earlier scroll follow-up

Scroll follow-up: native layout heartbeats now renew the visibility lease without repeatedly calling `setBounds`/`setVisible` for unchanged geometry. Stable toolbar state no longer triggers React updates, and polling pauses during close confirmation. Tests verify that 20 identical heartbeats cause only one bounds update, while resize, hide, re-show and lease expiry still work. This removes redundant work; it is not yet evidence of improved physical scroll smoothness. Applying the main-process change to an already-open preview requires relaunching that preview and clears its temporary browser session.

An opt-in **Try native view** button is available when Fleet's updated desktop preload is present. It embeds Electron's `WebContentsView` directly in the Fleet window, using the screen's normal pixel density; it does not capture/compress/stream JPEGs. The existing full-Chrome browser and Rust controller are unchanged. This is explicitly a **manual-only preview**, not a replacement agent browser: no Rust/CDP connection, agent sharing, saved login migration, downloads, extra windows or browser permission prompts. Public sites may behave differently in Electron Chromium, including authentication, codecs and bot challenges. No stealth or challenge-bypass changes are made.

Each preview has a separate non-persistent session and the existing DNS-pinning proxy/private-network policy. Remote content has no preload, Node, webview or IPC access. Only Fleet's trusted main renderer can invoke the narrow desktop controls. The native view is hidden when its renderer stops renewing its layout lease, when a dialog/menu covers it, or during close confirmation. Resizing follows the available window area. Closing/unmounting destroys the page and clears its session. This is not an OS sandbox and is not yet a full browser feature set.

Run `npm run desktop:preview` to open a separate Fleet preview window using a temporary desktop profile and the already-running service. It refuses to create another daemon or workspace. Normal Fleet and its browser sessions stay open. Optional `FLEET_NATIVE_PROJECT=<project-id>` and `FLEET_NATIVE_URL=<url>` prefill the native-preview setup page; the user still clicks **Open native preview**.

Tests: `node tests/live-native-browser.mjs --run` checks real native input, scrolling, navigation/back, sizing, page isolation, blocked internal/file navigation, blocked private HTTP, pop-up suppression and cookie cleanup. `--public` additionally samples Shopify video in its own profile; two runs observed the 1080p hero video advance ~192 frames over eight seconds with zero decoder drops. A native 1240×800-DIP surface produced a 2480×1600 screenshot on this Retina display. These are decoder and resolution checks, **not a measurement of physical display smoothness or a guarantee of site compatibility**. `--ui` checks the actual React component and production preload: explicit start, visible native child, window resizing, hiding during confirmation, and destruction on close.

## Remaining input-to-frame latency

### Follow-up: video pacing remains unresolved

`node tests/live-browser-latency.mjs --run --shopify --video` waits for a loaded, playing on-screen video, then samples eight seconds of the source video's playback-quality counters, capture arrival and the actual Fleet image load events. It uses a separate temporary profile and does not control the user's current tab. The optional visual marker is updated by `requestVideoFrameCallback`; marker transitions are **not** a count of unique video pictures, because that callback and the marker repaint can lag the video compositor.

The tested Shopify clip decoded 192–193 pictures over eight seconds (~24fps), with zero decoder drops in the loaded runs. Fleet likewise loaded 192–193 images. With the current JPEG-80 path, an eight-second run had a 41.4ms median image-load gap, 56.8ms p95 and 64.3ms maximum. A separate six-second read-only sample of the user's active stream received 144 frames, zero duplicate sequences, a 63ms p95 arrival gap and a 95ms maximum. The latter measures server-to-client arrival, not the user's displayed pixels. This does not reproduce or exclude longer freezes elsewhere.

Two isolated experiments were reverted: synchronous `<img>` decoding (56.5ms p95 load gap) and JPEG quality 60 (56.3ms p95, about 2.25MB/s versus 3.21MB/s at quality 80). Neither established a meaningful improvement in motion. The remaining video complaint is not fixed; no production setting was changed and the user's open browser was not restarted during this follow-up.

### Direct full-Chrome frame delivery

Full Chrome now captures through its existing private CDP connection straight into Fleet's authenticated frame stream, avoiding the native controller's additional frame relay. The Rust controller still handles agent tools; image quality remains JPEG 80 and the windowless launch, ownership checks, approvals and network protections are unchanged. Headless/non-owned Chrome retains the native stream fallback. Capture stops on the previous tab, restarts on viewport changes, acknowledges stale captures without displaying them, and tracks main-document navigation separately from iframes.

Repeated isolated input-to-decoded-image checks on this machine:

| Page                       | Original relay: median / p95     | Direct frames: median / p95    |
| -------------------------- | -------------------------------- | ------------------------------ |
| Dense local scroll fixture | 79.7 / 185.0ms; 78.2 / 110.4ms   | 68.1 / 90.8ms; 67.4 / 92.8ms   |
| Public Shopify home page   | 106.5 / 137.1ms; 107.3 / 142.9ms | 93.6 / 126.2ms; 96.4 / 123.3ms |

Every run sent 90 wheel events and verified all 720 pixels reached the decoded Fleet image. This is a measured improvement, **not evidence that Shopify now feels native or that all reported lag is eliminated**. Public-page tests use a fresh profile and a small test-only visual scroll marker, not the user's session or a signed-in Shopify admin page. They do not measure physical monitor presentation time. The capture/transport stage estimates may pair adjacent visual frames; only the end-to-end barcode result is the comparison metric.

Reproduce with `node tests/live-browser-latency.mjs --run`, adding `--shopify` for the public page and `--legacy-stream` for the old relay. Run comparisons sequentially to avoid competing browser workloads. TCP_NODELAY injection, native ACK pacing and faster wheel timers did not establish a reliable overall win and are not enabled. In particular, removing only the post-ack wheel delay measured 97.9 / 119.1ms on Shopify; the original bounded wheel queue was retained.

Verification: 104 backend tests and 75 UI tests pass, plus the production build. Real full-Chrome checks passed from the Desktop data layout with foreground preservation, no native windows, tab switching, resizing, screenshots, input and live frames; the headless fallback passed too. The idle local daemon was restarted with the change on September 7, 2026, after verifying no project browsers or active agents/terminals. All five project IDs, 18 chat IDs/statuses, three trash IDs and service limits matched before and after. No personal Chrome sessions or model calls were used.

### Earlier baseline

`node tests/live-browser-latency.mjs --run` now exercises the actual Fleet React browser component, HTTP input, full Chrome, frame delivery and decoded image output in isolated profiles. A local scroll fixture encodes its position visually; 90 wheel events must reach the displayed image without losing distance. It does not measure a physical monitor's presentation time or certify Shopify's performance.

Before the direct-frame change, the implementation measured approximately 80–99ms median and 113–161ms p95 across two runs. Image loading/decoding after the src update was about 3ms. Removing the wheel timer, allowing two outstanding wheel acknowledgements, disabling smooth scrolling and removing the upstream frame-rate cap did not establish a reliable improvement. Those production-code experiments were reverted; only the reproducible diagnostic was retained. The duplicate-frame fix remained in place, but the user's reported interaction lag was not resolved. No restart or change to the user's current Shopify session was made during those experiments.

## Update: windowless full Chrome and low-overhead input

Large-page lag regression: `streamFrames` treated a drained response buffer as a reason to resend the cached frame, even when it had already been accepted by `write()`. Shopify's ~107KB frames exposed a self-sustaining resend loop; a six-second read-only sample received 78,555 frame records and 8.37GB over loopback. The sender now clears accepted frames before writing and drains only the newest _unsent_ frame, with approval refresh notifications retained separately. A regression test fails on the previous implementation; both simulated backpressure and real HTTP tests cover large stationary frames. An isolated Shopify run with the fix delivered 68 records (67 new native frames plus the initial cached frame), zero duplicates and 7.25MB in three seconds. This verifies delivery behavior, not end-to-end display latency. All 101 backend tests passed.

After the user-approved service restart, Shopify was reopened in Game's Fleet browser. The production stream delivered 96 frames, zero duplicates and 10.76MB in four seconds. All five projects and 18 chats retained their IDs and statuses. Chrome remained in full, background mode.

Startup regression: macOS LaunchServices rejected the stderr FIFO when it lived inside Fleet's Desktop data directory (`-10810`), before Chrome exposed CDP. Temporary-directory-only tests missed this. The FIFO now lives in a private OS temporary directory and is removed on close; the Chrome profile stays in its project session directory. Reproduce the production layout with `node tests/live-browser.mjs --run --visible --desktop-path --focus --stream-test --input-test`. The corrected Desktop-path trial passed launch, input, tabs, mobile frames and the no-native-window checks (66 frames in 1.2 seconds).

The earlier focus-restoration approach allowed a brief activation flash. It is replaced on macOS by launching owned full Chrome through `open -n -g -W` with `--no-startup-window`. Tabs are hidden CDP targets from creation, rather than normal windows hidden afterward. A private gateway rewrites native controller tab creation and suppresses activation. Focus emulation and device metrics preserve live frames. Chrome is not headless, and personal profiles are untouched. Live tests assert no native window across launch/new-tab/tab-switch/a page popup, foreground PID preservation, working inputs and mobile live frames. This does not certify every site's popup or native-dialog behavior.

The authenticated NDJSON stream now requests up to 60 fps, with backpressure and disconnect cleanup. The animated local fixture delivered 65 frames in 1.2 seconds in attached mode (about 54 fps); the previous 24-fps configuration delivered 27–28. Frames update an isolated React leaf instead of the whole control panel. Trackpad deltas are coalesced, not converted to fixed jumps. Persistent CDP input avoids CLI forks: seven-sample backend medians were 1.2 ms click, 0.6 ms typing, 0.8 ms key and 29.9 ms wheel. These measure acknowledgement, not end-to-end display latency, and are not guarantees on other pages. Run `node tests/live-browser.mjs --run --visible --focus --stream-test --input-test`, or replace `--visible` with `--attached`. Tests use isolated profiles and no model calls.

Shared browser grants now survive chat turns while credentials remain attempt-specific. Workers verify the required browser MCP tool before starting a model turn, disable the inherited `cua_repl` server for their process configuration, and instruct new-site requests to use new tabs instead of closing/reopening Chrome. Unshared chats give connection guidance. `node tests/live-browser-tools.mjs --run` verifies fresh-thread tool discovery against installed Codex without a model call; real persisted-thread resume is not covered by that test, while fixture worker tests cover fresh/resumed options and readiness ordering.

## Update: domain filtering removed

Public domains are now unrestricted in all three modes. Fleet no longer sends `allowedDomains`, collects extra-site approvals or checks public origins during navigation. The proxy still pins DNS and blocks private/reserved networks and internal services, with an exception for the initial loopback preview origin. Agent action approvals and dedicated profiles remain. These network safeguards are not an OS sandbox; the upstream domain guard's page/worker/WebRTC protections are no longer enabled in any mode.

Verification after removal: all 90 backend tests and 71 UI tests pass, along with the production build. Real Chrome checks passed in headless, visible and attached modes: local input/tab/stream behavior, blocked unrelated loopback HTTP/WebSocket requests, and navigation/new-tab access to `example.com` and `example.org` without an allowlist. Reproduce with `node tests/live-browser.mjs --run --public`, adding `--visible` or `--attached` for those modes. No user sessions or model calls are used by these tests.

The measurements and containment descriptions below are historical observations from before this change, not claims about the current domain policy.

Tested locally on September 7, 2026 (Europe/London), macOS ARM64, Node 24.18.1, native Rust agent-browser 0.36.0 and Chrome 152. No personal profiles or paid model calls.

## Outcome

Both modes passed the local interaction and safety trials. Keeping the Rust controller while opening visible Chrome did not show a material warm-input latency penalty in this small fixture. **Google still returned a bot challenge and HTTP 429 in both modes.** This is not an undetected-browser implementation.

Visible mode uses the supported `headed: true` setting; the previous `headless: true` key was not the documented configuration key (headless happened to be the default). Neither mode spoofs its user agent, hides `navigator.webdriver`, imports a personal Chrome profile, or drops the domain guard. The local fixture observed `HeadlessChrome/152.0.0.0` versus `Chrome/152.0.0.0`; `webdriver` was true in both.

## Warm measurements

Seven samples per operation and mode, alternating which mode went first each round. Both project streams were connected; the fixture and viewport were the same (1280 × 800). These measure Fleet's backend control path, including CLI calls, output handling and screenshot file I/O, not end-to-end UI latency, page-load speed, memory usage or FPS. The fill path includes Fleet's follow-up URL lookup. Timings below are the final complete run; normal machine noise applies.

| Operation  | Headless median (min–max) | Visible median (min–max) |
| ---------- | ------------------------- | ------------------------ |
| Snapshot   | 6.1 ms (5.5–11.4)         | 6.1 ms (5.7–7.4)         |
| Fill field | 11.7 ms (9.1–28.1)        | 10.9 ms (10.3–20.7)      |
| Screenshot | 44.8 ms (22.9–57.1)       | 34.3 ms (33.4–57.0)      |

One launch sample was 615.9 ms headless and 611.6 ms visible. These samples cannot establish a launch-speed winner. An earlier local run had screenshot medians of 35.6/43.3 ms respectively, illustrating why neither mode should be advertised as universally faster. The previous Playwright bake-off used a different fixture and harness; do not compare its absolute timings with this trial.

## Verified in both modes

- Native input, screenshot capture, tab creation/switching, reload and mobile stream resizing.
- Exact-origin proxy still blocked page HTTP and WebSocket access to an unapproved loopback port; unsafe individual tab closure was rejected.
- Agent read access and explicitly approved clicks worked through the real browser broker, using a deterministic worker identity rather than a model.
- Human takeover rejected pending actions and invalidated the previous agent token without relaunching Chrome.
- Dummy HttpOnly session cookie survived reload and takeover; closing and reopening created a fresh session. No real account authentication was tested.
- Keep-open survived a simulated idle-expiry check; explicit close/shutdown still disposed of the session.

The initial retention test had a fixture bug: its favicon response overwrote the visible-mode dummy cookie. The fixture now returns 204 for favicon requests, and both retention tests passed. The first public-site evidence collector also tried to parse Fleet's deliberately truncated evidence as complete JSON; it now classifies bounded snapshot text and prints only sanitised status metadata.

## Public-site observation

The completed public check opened one Google search per mode with explicit Google, consent and static-resource origins in isolated test sessions. Both observations contained challenge text and network status 429. No consent choice was submitted, no CAPTCHA was clicked or solved, and no login was attempted. A previous observation attempt visited the same search but failed in the evidence collector as described above. This is a point-in-time observation, not a site-compatibility certification or proof of what triggered Google's decision.

## Session lifetime and constraints

Keep-open means the existing browser stays alive between chats while Fleet's background service runs. It is not saved-profile restoration. Closing the desktop window does not stop the background service. Explicitly closing the project browser or stopping/restarting the service ends the session.

Upstream rejects profiles, pre-existing browser attachment and state restoration when the domain allowlist is enabled; restoring startup pages could execute before containment is installed. This implementation keeps that restriction, as documented in [agent-browser security](https://agent-browser.dev/security) and uses the supported [headed configuration](https://agent-browser.dev/configuration).

Take control before using the native window for manual verification. Native-window input cannot be locked while a chat browses, and an already-dispatched agent action may finish. Site challenges can remain in either mode. Full disk-persistent login sessions need a separate containment/storage design.

## Follow-up: independently launched Chrome + Rust attachment

On the same day, after the user confirmed everyday Chrome could search without a challenge, an isolated CDP-attachment diagnostic produced a different result. `node tests/browser-attach.mjs --run --public` launched the installed Chrome with a fresh, dedicated test profile and loopback debugging endpoint, then attached the same Rust controller. It did not access personal profiles/tabs, spoof the user agent, patch browser fingerprints or change Fleet's production configuration.

**Observed once:** Google search results were visible behind its ordinary cookie-consent dialog. The screenshot was visually inspected; the diagnostic found no CAPTCHA/challenge and no HTTP 429. Network statuses included 200, 204 and 403, so this does not certify complete subresource compatibility. No consent choice was submitted and no account login was tested. The text-only snapshot captured the modal rather than the underlying results, so its `resultsText: false` classification is not evidence that the screenshot lacked results.

The local fixture reported `webdriver: false` and a normal Chrome user agent. This differs from the two launcher-controlled modes above, but one observation does not isolate the cause of Google's decision or guarantee future success. Profile, launch configuration, timing and network behaviour can all differ.

Native input, click, snapshots, screenshots and streamed frames worked. The exact-origin proxy blocked the fixture's unapproved HTTP and WebSocket attempts. Seven native-command samples gave medians of 6.4 ms for snapshot, 5.9 ms for fill and 55.0 ms for screenshot. This diagnostic times direct CLI commands, unlike the earlier Fleet-wrapper benchmark, and is not an apples-to-apples comparison of their full application paths.

**At the time of this first diagnostic, attachment was not enabled in Fleet.** Upstream CDP attachment does not support its `allowedDomains` guard. The experiment retains the exact-origin proxy and non-proxied-UDP policy, but does not claim the same page/worker/WebRTC containment as Fleet's isolated mode. See the explicitly acknowledged experimental integration below, [supported CDP attachment](https://agent-browser.dev/cdp-mode) and [Chrome's dedicated-profile debugging requirement](https://developer.chrome.com/blog/remote-debugging-port).

Artifacts: `/var/folders/17/k82_snbx6kbf465bpylrzh340000gn/T/fleet-attach-trial-T2heRS/local.png` and `public.png`. The diagnostic closed its own session and Chrome child; the profile directory is retained for inspection.

## Integrated experimental option

At the user's request, Fleet now offers **Independent Chrome · Experimental** alongside its existing visible/headless isolated modes. It is not the default. Its launch API requires `mode: "attached"`, normal site approval and a separate `experimentalApproved: true` acknowledgement. The UI resets this acknowledgement when changing modes and keeps a reduced-containment label visible during use.

The launcher creates a fresh profile in that session's private directory, opens only `about:blank` initially and consumes the debugging endpoint emitted by its own Chrome child. It never discovers personal Chrome or accepts an arbitrary CDP endpoint/profile from a launch request. The exact-origin proxy and command/action gates remain; the upstream page/worker/WebRTC guard is absent only in this explicitly selected mode. Native UI interaction remains outside Fleet's approval gate. Treat this as a trusted-site testing option, not equivalent isolation.

Integrated local tests passed input, tab creation/switching, reload, mobile stream, screenshots, proxy blocking of unapproved HTTP/WebSocket traffic, cookie retention across takeover, fresh state after close, keep-open, action approval and token revocation. API/UI tests cover the extra consent and reset, endpoint redaction, process exit, launch-failure cleanup and no silent fallback. The initial tab-count assertion was corrected to account for the independently launched Chrome's startup blank tab; the tests still verify new-tab count changes and returning to the original controlled page with state intact.

The integrated Google observation again detected ordinary consent, no challenge, and statuses 200/204 with no 429. Consent was not submitted and no login was attempted. This is another point-in-time observation, not a guarantee. Seven warm samples through Fleet's actual control path measured medians of 6.4 ms snapshot, 11.0 ms fill and 42.5 ms screenshot; the single launch sample was 490.4 ms. Artifact directory: `/var/folders/17/k82_snbx6kbf465bpylrzh340000gn/T/fleet-browser-modes-NWOUoh`.

## Reproduce

```sh
npm run check
node tests/live-browser.mjs --run
node tests/live-browser.mjs --run --visible
node tests/browser-modes.mjs --run
# Optional external-site observation; no automatic retries or challenge interaction:
node tests/browser-modes.mjs --run --public
# Diagnostic only: fresh owned Chrome + Rust attachment, not a production mode:
node tests/browser-attach.mjs --run --public
# Integrated experimental mode (local test first; public observation is opt-in):
node tests/live-browser.mjs --run --attached
node tests/browser-modes.mjs --run --attached-only
```

The scripts close only their own named sessions and retain isolated diagnostic directories. The final comparison directory was `/var/folders/17/k82_snbx6kbf465bpylrzh340000gn/T/fleet-browser-modes-4EdTzp`.
