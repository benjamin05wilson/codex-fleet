// Diagnostic only: full Chrome hidden targets, no personal profile or model calls.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOwnedChrome } from "../server/owned-chrome.mjs";
import { createBrowserProxy } from "../server/browser-network.mjs";
import http from "node:http";
import assert from "node:assert/strict";
if (!process.argv.includes("--run")) {
  console.log("Run with --run to test an isolated, windowless full Chrome.");
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), "fleet-hidden-trial-"));
const page = http.createServer((req, res) =>
  res.end(
    '<title>Hidden trial</title><input><button onclick="document.body.style.background=\"red\"">Apply</button><p id="tick"></p><script>let t=0;setInterval(()=>document.querySelector("#tick").textContent=++t,40)</script>',
  ),
);
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${page.address().port}`;
const proxy = await createBrowserProxy([url], [4317]);
let chrome, socket;
try {
  chrome = await launchOwnedChrome({
    directory,
    proxyPort: proxy.port,
    background: true,
  });
  socket = new WebSocket(chrome.endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0,
    frames = 0;
  const pending = new Map();
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(method + " timed out"));
      }, 5000);
      pending.set(key, (v) => {
        clearTimeout(timer);
        v.error ? reject(new Error(v.error.message)) : resolve(v.result);
      });
      socket.send(
        JSON.stringify({
          id: key,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  socket.onmessage = ({ data }) => {
    const v = JSON.parse(data);
    if (v.id) {
      pending.get(v.id)?.(v);
      pending.delete(v.id);
    }
    if (v.method === "Page.screencastFrame") {
      frames++;
      call(
        "Page.screencastFrameAck",
        { sessionId: v.params.sessionId },
        v.sessionId,
      ).catch(() => {});
    }
  };
  assert.equal(await chrome.pages.hasWindow(), false);
  const { targetId } = await call("Target.createTarget", {
    url,
    hidden: true,
    background: true,
  });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await call("Page.enable", {}, sessionId);
  await call(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await call(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    sessionId,
  );
  await call(
    "Page.startScreencast",
    { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 800 },
    sessionId,
  );
  await new Promise((r) => setTimeout(r, 1200));
  console.log({ frames });
  await call("Page.bringToFront", {}, sessionId);
  await assert.rejects(
    call("Browser.getWindowForTarget", { targetId }),
    /window not found/i,
  );
  assert.ok(frames > 8);
} finally {
  socket?.close();
  await chrome?.close();
  await proxy.close();
  await new Promise((r) => page.close(r));
  console.log(directory);
}
