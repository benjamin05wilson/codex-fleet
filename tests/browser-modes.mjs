// Opt-in, isolated real-Chrome comparison. No personal profiles or model calls.
// --public additionally visits one Google search per mode, without clicking consent/CAPTCHA.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Browsers } from "../server/browsers.mjs";

if (!process.argv.includes("--run")) {
  console.log(
    "Run node tests/browser-modes.mjs --run [--public]. Opens two isolated Chrome sessions, including one visible window.",
  );
  process.exit(0);
}
const modes = process.argv.includes("--attached-only")
  ? ["attached"]
  : ["headless", "visible"];
const dataDir = await mkdtemp(join(tmpdir(), "fleet-browser-modes-"));
const page = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const mode = req.url.includes("attached")
    ? "attached"
    : req.url.includes("visible")
      ? "visible"
      : "headless";
  const remembered = req.headers.cookie?.includes(`fleet_trial=${mode}`);
  res.setHeader(
    "Set-Cookie",
    `fleet_trial=${mode}; HttpOnly; SameSite=Strict; Path=/`,
  );
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>Fleet browser modes</title>
    <style>body{font:18px system-ui;padding:32px;background:#181a20;color:#eee}input,button{font:inherit;padding:12px;margin:8px}</style>
    <h1>${mode} trial</h1><p>${remembered ? "Session remembered" : "Fresh isolated session"}</p>
    <label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output>
    <p id="agent"></p><script>document.getElementById('agent').textContent='User agent: '+navigator.userAgent+'; webdriver: '+navigator.webdriver;</script>`);
});
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${page.address().port}`;
const runs = Object.fromEntries(
  modes.map((mode) => [
    mode,
    {
      id: `run-${mode}`,
      projectId: mode,
      status: "draft",
      title: "Local handoff fixture",
    },
  ]),
);
const browsers = new Browsers({
  dataDir,
  store: {
    get: (kind, id) =>
      kind === "project"
        ? { id }
        : Object.values(runs).find((r) => r.id === id),
  },
});
const metrics = Object.fromEntries(
  modes.map((m) => [m, { snapshot: [], fill: [], screenshot: [] }]),
);
const action = (mode, input) => browsers.control(mode, input, "qa");
const snapshot = async (mode) =>
  JSON.parse((await action(mode, { action: "snapshot" })).output);
const reference = (data, name) => {
  const item = Object.entries(data.refs).find(
    ([, v]) => v.name.trim() === name,
  );
  assert.ok(item, `Missing ${name} reference`);
  return "@" + item[0];
};
const measure = async (fn) => {
  const start = performance.now();
  await fn();
  return Math.round((performance.now() - start) * 10) / 10;
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for browser state");
};
const publicResults = [];
try {
  const launchMs = {},
    refs = {},
    signals = {};
  for (const mode of modes) {
    launchMs[mode] = await measure(() =>
      browsers.start(
        mode,
        {
          url: `${origin}/${mode}`,
          approved: true,
          mode,
          keepOpen: true,
          ...(mode === "attached" ? { experimentalApproved: true } : {}),
        },
        "qa",
      ),
    );
    const data = await snapshot(mode);
    assert.match(data.snapshot, /Fresh isolated session/);
    refs[mode] = reference(data, "Name");
    signals[mode] = data.snapshot
      .split("\n")
      .find((line) => line.includes("User agent:"));
    await action(mode, { action: "fill", target: refs[mode], text: "warmup" });
    await action(mode, { action: "screenshot" });
  }
  // Alternate which mode goes first in each warm round, with both streams active.
  for (let round = 0; round < 7; round++) {
    for (const mode of round % 2 ? [...modes].reverse() : modes) {
      metrics[mode].snapshot.push(
        await measure(async () => {
          assert.match((await snapshot(mode)).snapshot, /trial/);
        }),
      );
      metrics[mode].fill.push(
        await measure(() =>
          action(mode, {
            action: "fill",
            target: refs[mode],
            text: `sample-${round}`,
          }),
        ),
      );
      metrics[mode].screenshot.push(
        await measure(async () => {
          assert.ok(
            (await action(mode, { action: "screenshot" })).image.length > 100,
          );
        }),
      );
    }
  }
  for (const mode of modes) {
    const session = browsers.sessions.get(mode);
    await browsers.expireIdle(Date.now() + 31 * 60 * 1000);
    assert.equal(browsers.sessions.get(mode), session);
    const data = await snapshot(mode);
    const apply = reference(data, "Apply");
    browsers.grant(mode, runs[mode].id, "qa", true);
    const c = browsers.connection(runs[mode], `attempt-${mode}`);
    Object.assign(runs[mode], {
      status: "running",
      worker: { identity: `attempt-${mode}` },
    });
    assert.match(
      (await browsers.agent(c.token, { action: "snapshot" })).output,
      /sample-6/,
    );
    const pending = browsers.agent(c.token, { action: "click", target: apply });
    await waitFor(() => browsers.state(mode).pending);
    browsers.approve(
      mode,
      { id: browsers.state(mode).pending.id, approved: true },
      "qa",
    );
    await pending;
    const cancelled = browsers.agent(c.token, {
      action: "fill",
      target: refs[mode],
      text: "must-not-appear",
    });
    const rejection = assert.rejects(cancelled, /revoked/);
    await waitFor(() => browsers.state(mode).pending);
    browsers.take(mode, "qa");
    await rejection;
    await assert.rejects(
      browsers.agent(c.token, { action: "snapshot" }),
      /expired|revoked/,
    );
    assert.equal(
      browsers.sessions.get(mode),
      session,
      "Takeover must preserve the native session",
    );
    assert.doesNotMatch((await snapshot(mode)).snapshot, /must-not-appear/);
    await action(mode, { action: "reload" });
    assert.match((await snapshot(mode)).snapshot, /Session remembered/);
    await action(mode, { action: "viewport", width: 390, height: 844 });
    await waitFor(() => browsers.frame(mode).width === 390);
    assert.ok(
      (await action(mode, { action: "screenshot" })).image.length > 100,
    );
    await browsers.stop(mode);
    await browsers.start(
      mode,
      {
        url: `${origin}/${mode}`,
        approved: true,
        mode,
        ...(mode === "attached" ? { experimentalApproved: true } : {}),
      },
      "qa",
    );
    assert.match((await snapshot(mode)).snapshot, /Fresh isolated session/);
    await browsers.stop(mode);
    console.log(
      `PASS ${mode}: input, screenshots, stream resize, keep-open, agent approval, takeover/revocation, session-cookie retention and fresh session after close.`,
    );
  }
  if (process.argv.includes("--public")) {
    for (const mode of modes) {
      try {
        await browsers.start(
          mode,
          {
            url: "https://www.google.com/search?q=rust+programming+language",
            approved: true,
            mode,
            ...(mode === "attached" ? { experimentalApproved: true } : {}),
          },
          "qa",
        );
        // One observation only: no retry loop, no consent actions, no CAPTCHA interaction.
        await new Promise((r) => setTimeout(r, 2000));
        // Fleet deliberately bounds evidence output, which can truncate large JSON.
        // Classify the bounded text without pretending it is a complete JSON document.
        const text = (await action(mode, { action: "snapshot" })).output;
        const current = new URL(browsers.state(mode).url);
        const network = await browsers.command(browsers.sessions.get(mode), [
          "network",
          "requests",
        ]);
        publicResults.push({
          mode,
          location: current.origin + current.pathname,
          challenge:
            /unusual traffic|not a robot|captcha|automated queries/i.test(
              text,
            ) || current.pathname.startsWith("/sorry"),
          consent: /before you continue|accept all|reject all/i.test(text),
          resultsText: /search results|rust programming language/i.test(text),
          // Output only status codes, never cookies, headers, payloads or URL query strings.
          statuses: [
            ...new Set(
              (network.requests || []).map((r) => r.status).filter(Boolean),
            ),
          ],
        });
      } catch (error) {
        publicResults.push({ mode, error: error.message });
      } finally {
        await browsers.stop(mode);
      }
    }
  }
  const summary = Object.fromEntries(
    modes.map((mode) => [
      mode,
      Object.fromEntries(
        Object.entries(metrics[mode]).map(([op, samples]) => {
          const sorted = [...samples].sort((a, b) => a - b);
          return [
            op,
            {
              medianMs: sorted[3],
              minMs: sorted[0],
              maxMs: sorted[6],
              samples,
            },
          ];
        }),
      ),
    ]),
  );
  console.log(
    JSON.stringify(
      { launchMs, signals, warm: summary, publicResults },
      null,
      2,
    ),
  );
} finally {
  await browsers.close();
  await new Promise((r) => page.close(r));
  console.log("Retained isolated diagnostic directory: " + dataDir);
}
