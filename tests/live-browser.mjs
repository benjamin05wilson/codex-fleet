// Opt-in real Chrome/network check. No model calls or personal profiles.
// --public additionally checks navigation to two public example domains.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browsers } from "../server/browsers.mjs";
import { foregroundPid } from "../server/browser-focus.mjs";
if (!process.argv.includes("--run")) {
  console.log(
    "Run node tests/live-browser.mjs --run to launch an isolated Chrome network check.",
  );
  process.exit(0);
}
// --desktop-path reproduces the real app's privacy-protected Desktop data
// location. The former launcher passed /tmp tests but failed in this layout.
const dataDir = await mkdtemp(
  join(
    process.argv.includes("--desktop-path")
      ? fileURLToPath(new URL("../.fleet/", import.meta.url))
      : tmpdir(),
    "fleet-live-browser-",
  ),
);
const mode = process.argv.includes("--attached")
  ? "attached"
  : process.argv.includes("--visible")
    ? "visible"
    : "headless";
let forbiddenHits = 0;
const forbidden = http.createServer((req, res) => {
  forbiddenHits++;
  res.end("private service");
});
forbidden.on("upgrade", (req, socket) => {
  forbiddenHits++;
  socket.destroy();
});
await new Promise((r) => forbidden.listen(0, "127.0.0.1", r));
const port = forbidden.address().port;
const page = http.createServer((req, res) => {
  if (req.url === "/input") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<style>input{position:fixed;left:10px;top:10px;width:250px;height:40px}body{height:6000px}</style><input aria-label="Fast input" oninput="document.querySelector('output').textContent=this.value"><output style="position:fixed;top:80px"></output>`,
    );
    return;
  }
  if (req.url === "/help") {
    res.end("<h1>Help tab</h1>");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>Browser safety trial</title><h1>Browser safety trial</h1>
  <label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output>
  <button onclick="window.open('/help','_blank')">Popup</button>
  <script>
    if (${process.argv.includes("--stream-test")}) {
      const counter = document.createElement('p');document.body.append(counter);
      let tick=0;setInterval(()=>{counter.textContent='Animation frame '+(++tick);},16);
    }
    let finished=0;function done(){if(++finished===2){const p=document.createElement('p');p.textContent='Network probes finished';document.body.append(p);}}
    fetch('http://127.0.0.1:${port}/private',{mode:'no-cors'}).then(done,done);
    const ws=new WebSocket('ws://127.0.0.1:${port}/private');ws.onerror=done;ws.onopen=()=>{ws.close();done();};
  </script>`);
});
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + page.address().port;
const browsers = new Browsers({
  dataDir,
  store: { get: () => ({ id: "network-qa" }) },
});
try {
  const previousFocus = process.argv.includes("--focus")
    ? await foregroundPid()
    : null;
  await browsers.start(
    "network-qa",
    {
      url,
      approved: true,
      mode,
      ...(mode === "attached" ? { experimentalApproved: true } : {}),
    },
    "qa",
  );
  const action = (action, extra = {}) =>
    browsers.control("network-qa", { action, ...extra }, "qa");
  if (previousFocus) {
    assert.equal(browsers.state("network-qa").focusWarning, null);
    assert.equal(
      await foregroundPid(),
      previousFocus,
      "Browser launch must preserve the foreground app",
    );
  }
  let output = "";
  for (let i = 0; i < 30; i++) {
    output = (await action("snapshot")).output;
    if (output.includes("Network probes finished")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /Network probes finished/);
  assert.equal(
    forbiddenHits,
    0,
    "Page HTTP/WebSocket requests must not bypass private-network protection",
  );
  const refs = JSON.parse(output).refs;
  const ref = (name) =>
    "@" + Object.entries(refs).find(([, v]) => v.name.trim() === name)[0];
  await action("fill", {
    target: ref("Name"),
    text: "Local integration passed",
  });
  await action("click", { target: ref("Apply") });
  assert.match((await action("snapshot")).output, /Local integration passed/);
  // Pinning an independently launched Chrome creates a controlled tab alongside
  // its startup blank tab. Check changes relative to the actual initial tabs.
  const initialTabs = await browsers.tabs("network-qa");
  const originalTab = initialTabs.find((tab) => tab.active);
  assert.ok(originalTab.url.startsWith(url));
  await action("newTab", { url: url + "/help" });
  if (previousFocus)
    assert.equal(
      await foregroundPid(),
      previousFocus,
      "New tab must preserve foreground app",
    );
  let tabs = await browsers.tabs("network-qa");
  assert.equal(tabs.length, initialTabs.length + 1);
  const helpTab = tabs.find((tab) => tab.url === url + "/help");
  await action("selectTab", { target: originalTab.id });
  if (previousFocus)
    assert.equal(
      await foregroundPid(),
      previousFocus,
      "Tab switch must preserve foreground app",
    );
  await assert.rejects(action("closeTab", { target: helpTab.id }), /disabled/);
  assert.equal(
    (await browsers.tabs("network-qa")).length,
    initialTabs.length + 1,
  );
  assert.match((await action("snapshot")).output, /Local integration passed/);
  await action("reload");
  const hiddenPages = browsers.sessions.get("network-qa").native?.pages;
  if (hiddenPages) {
    assert.equal(
      await hiddenPages.hasWindow(),
      false,
      "Launch and tab operations must not create a native window",
    );
    const popupRefs = JSON.parse((await action("snapshot")).output).refs;
    const popup =
      "@" + Object.entries(popupRefs).find(([, v]) => v.name === "Popup")[0];
    await action("click", { target: popup });
    assert.equal(
      await hiddenPages.hasWindow(),
      false,
      "Page popups must not create a native window",
    );
    if (previousFocus) assert.equal(await foregroundPid(), previousFocus);
  }
  assert.match((await action("snapshot")).output, /Browser safety trial/);
  await action("viewport", { width: 390, height: 844 });
  for (let i = 0; i < 30 && browsers.frame("network-qa").width !== 390; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(browsers.frame("network-qa").width, 390);
  assert.ok((await action("screenshot")).image.length > 100);
  if (process.argv.includes("--input-test")) {
    await action("navigate", { url: url + "/input" });
    const timings = { clickPoint: [], type: [], press: [], wheel: [] };
    for (let i = 0; i < 7; i++) {
      for (const input of [
        { action: "clickPoint", x: 30, y: 30 },
        { action: "type", text: "ab" },
        { action: "press", text: "Backspace" },
        { action: "wheel", deltaX: 0, deltaY: 100 },
      ]) {
        const began = performance.now();
        await action(input.action, input);
        timings[input.action].push(performance.now() - began);
      }
    }
    assert.match((await action("snapshot")).output, /aaaaaaa/);
    const medians = Object.fromEntries(
      Object.entries(timings).map(([key, values]) => [
        key,
        Number(values.sort((a, b) => a - b)[3].toFixed(1)),
      ]),
    );
    console.log(
      "Warm backend input acknowledgement medians, 7 samples (ms; not display latency):",
      medians,
    );
    if (hiddenPages) assert.equal(await hiddenPages.hasWindow(), false);
    await action("navigate", { url });
  }
  if (process.argv.includes("--stream-test")) {
    let frames = 0;
    const listener = (frame) => {
      if (frame?.image) frames++;
    };
    const session = browsers.sessions.get("network-qa");
    session.frameListeners.add(listener);
    await new Promise((r) => setTimeout(r, 1200));
    session.frameListeners.delete(listener);
    assert.ok(
      frames >= 8,
      `Expected live frames above the former 5fps polling cap; got ${frames} in 1.2s`,
    );
    console.log(`Live frame delivery (${mode}): ${frames} frames in 1.2s.`);
  }
  if (process.argv.includes("--public")) {
    for (const [command, publicUrl] of [
      ["navigate", "https://example.com"],
      ["newTab", "https://example.org"],
    ]) {
      await action(command, { url: publicUrl });
      assert.match((await action("snapshot")).output, /Example Domain/);
    }
    console.log(
      `PASS (${mode}): public navigation and new tab across two domains without an allowlist.`,
    );
  }
  console.log(
    `PASS (${mode}): real Chrome input, tab creation/switching, page state retained, reload, mobile stream, screenshots; unsafe tab close and page HTTP/WebSocket attempts to an unapproved localhost port blocked. No model calls.`,
  );
} finally {
  await browsers.close();
  await Promise.all(
    [page, forbidden].map((server) => new Promise((r) => server.close(r))),
  );
  console.log("Retained isolated diagnostic directory: " + dataDir);
}
