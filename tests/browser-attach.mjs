// Diagnostic only, NOT a Fleet browser mode. Uses a fresh owned Chrome profile.
// CDP attachment cannot use agent-browser's allowedDomains containment. Keep the
// exact-origin proxy, test only this controlled fixture and (opt-in) Google,
// and never import a personal profile or change the production browser guard.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBrowserProxy } from "../server/browser-network.mjs";

if (!process.argv.includes("--run")) {
  console.log(
    "node tests/browser-attach.mjs --run [--public]: isolated native Chrome + Rust/CDP trial, not personal Chrome. No model calls.",
  );
  process.exit(0);
}
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome))
  throw new Error(
    "This macOS trial needs Google Chrome installed in /Applications.",
  );
const root = await mkdtemp(join(tmpdir(), "fleet-attach-trial-"));
const bin = fileURLToPath(
  new URL(
    `../node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
    import.meta.url,
  ),
);
const session = "fleet-attach-trial-" + randomUUID();
const config = join(root, "agent-browser.json");
const exec = promisify(execFile);
const environment = Object.fromEntries(
  ["HOME", "USER", "PATH", "TMPDIR"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
let child, proxy, stream;
let blockedHits = 0;
const blocked = http.createServer((_req, res) => {
  blockedHits++;
  res.end("private fixture");
});
blocked.on("upgrade", (_req, socket) => {
  blockedHits++;
  socket.destroy();
});
await new Promise((r) => blocked.listen(0, "127.0.0.1", r));
const blockedPort = blocked.address().port;
const fixture = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>Fleet attach trial</title><h1>Native Chrome attach trial</h1>
    <label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output>
    <p id="signals"></p><p id="probes"></p><script>
    document.getElementById('signals').textContent='webdriver: '+navigator.webdriver+'; UA: '+navigator.userAgent;
    let done=0;const finish=()=>{if(++done===2)document.getElementById('probes').textContent='Network probes complete'};
    fetch('http://127.0.0.1:${blockedPort}/private',{mode:'no-cors'}).then(finish,finish);
    const ws=new WebSocket('ws://127.0.0.1:${blockedPort}/private');ws.onerror=finish;ws.onopen=()=>{ws.close();finish()};
    </script>`);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const localOrigin = `http://127.0.0.1:${fixture.address().port}`;
// Reserve a fixed nonzero loopback debugging port. Never probe existing Chrome ports.
const reserve = net.createServer();
await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
const debugPort = reserve.address().port;
await new Promise((r) => reserve.close(r));
const command = async (args) => {
  const { stdout } = await exec(
    bin,
    ["--session", session, "--config", config, "--json", ...args],
    {
      cwd: root,
      env: {
        ...environment,
        AGENT_BROWSER_DEFAULT_TIMEOUT: "10000",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000",
      },
      timeout: 15000,
      maxBuffer: 2000000,
    },
  );
  const result = JSON.parse(stdout);
  if (!result.success)
    throw new Error(result.error || "Native browser command failed");
  return result.data;
};
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (child?.exitCode != null)
      throw new Error("Owned Chrome exited during trial");
    try {
      if (await fn()) return;
    } catch (e) {
      if (i === 99) throw e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for owned Chrome");
};
const measure = async (fn) => {
  const start = performance.now();
  await fn();
  return Math.round((performance.now() - start) * 10) / 10;
};
try {
  const publicOrigins = process.argv.includes("--public")
    ? [
        "https://www.google.com",
        "https://consent.google.com",
        "https://www.google.co.uk",
        "https://www.gstatic.com",
      ]
    : [];
  proxy = await createBrowserProxy(
    [localOrigin, ...publicOrigins],
    [4317, debugPort, blockedPort],
  );
  // Native Chrome launch with a dedicated profile. No headless/enable-automation,
  // webdriver override, UA spoof, fingerprint patch, extensions or personal state.
  child = spawn(
    chrome,
    [
      `--user-data-dir=${join(root, "chrome-profile")}`,
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "about:blank",
    ],
    { stdio: "ignore", env: environment },
  );
  let launchError;
  child.on("error", (error) => {
    launchError = error;
  });
  await waitFor(async () => {
    if (launchError) throw launchError;
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return r.ok;
  });
  const policy = join(root, "policy.json");
  await writeFile(
    policy,
    JSON.stringify({
      default: "allow",
      deny: ["eval", "download", "upload", "state"],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    config,
    JSON.stringify({
      cdp: String(debugPort),
      pinTab: true,
      restoreSave: "never",
      actionPolicy: policy,
      maxOutput: 24000,
    }),
    { mode: 0o600 },
  );
  await command(["open", localOrigin]);
  await command(["set", "viewport", "1280", "800"]);
  let snapshot;
  await waitFor(async () => {
    snapshot = await command(["snapshot"]);
    return snapshot.snapshot.includes("Network probes complete");
  });
  assert.equal(blockedHits, 0);
  const ref = (name) =>
    "@" +
    Object.entries(snapshot.refs).find(([, v]) => v.name.trim() === name)[0];
  const nameRef = ref("Name"),
    applyRef = ref("Apply");
  await command(["fill", nameRef, "Native attach passed"]);
  await command(["click", applyRef]);
  assert.match((await command(["snapshot"])).snapshot, /Native attach passed/);
  const signals = snapshot.snapshot
    .split("\n")
    .find((line) => line.includes("webdriver:"));
  const streamState = await command(["stream", "status"]);
  let frames = 0;
  stream = new WebSocket(`ws://127.0.0.1:${streamState.port}/?maxFps=8`);
  stream.onmessage = (e) => {
    try {
      if (JSON.parse(String(e.data)).type === "frame") frames++;
    } catch {}
  };
  stream.onerror = () => {};
  await waitFor(() => frames > 0);
  const samples = { snapshot: [], fill: [], screenshot: [] };
  for (let i = 0; i < 7; i++) {
    samples.snapshot.push(await measure(() => command(["snapshot"])));
    samples.fill.push(
      await measure(() => command(["fill", nameRef, "Native attach passed"])),
    );
    samples.screenshot.push(
      await measure(() => command(["screenshot", join(root, "local.png")])),
    );
  }
  const medians = Object.fromEntries(
    Object.entries(samples).map(([k, v]) => [
      k,
      [...v].sort((a, b) => a - b)[3],
    ]),
  );
  let publicResult = null;
  if (publicOrigins.length) {
    await command([
      "open",
      "https://www.google.com/search?q=rust+programming+language",
    ]);
    await new Promise((r) => setTimeout(r, 2000));
    const page = await command(["snapshot"]);
    const current = await command(["get", "url"]);
    const url = new URL(typeof current === "string" ? current : current.url);
    const network = await command(["network", "requests"]);
    publicResult = {
      location: url.origin + url.pathname,
      challenge:
        /unusual traffic|not a robot|captcha|automated queries/i.test(
          page.snapshot,
        ) || url.pathname.startsWith("/sorry"),
      consent: /before you continue|accept all|reject all/i.test(page.snapshot),
      resultsText: /search results|rust programming language/i.test(
        page.snapshot,
      ),
      statuses: [
        ...new Set(
          (network.requests || []).map((r) => r.status).filter(Boolean),
        ),
      ],
    };
    await command(["screenshot", join(root, "public.png")]);
  }
  console.log(
    JSON.stringify(
      {
        localTests:
          "PASS input, snapshots, stream, screenshots, blocked HTTP/WebSocket fixture",
        signals,
        medianMs: medians,
        samples,
        publicResult,
      },
      null,
      2,
    ),
  );
} finally {
  stream?.close();
  if (existsSync(config)) await command(["close"]).catch(() => {});
  // Only this child/profile belongs to the trial; never kill all Chrome processes.
  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (child.exitCode == null && child.signalCode == null)
      child.kill("SIGKILL");
  }
  await proxy?.close();
  await Promise.all(
    [fixture, blocked].map((s) => new Promise((r) => s.close(r))),
  );
  console.log("Retained isolated trial directory: " + root);
}
