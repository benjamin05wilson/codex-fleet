// Opt-in real Chrome/network check. No model calls, personal profiles or external sites.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browsers } from "../server/browsers.mjs";
if (!process.argv.includes("--run")) {
  console.log(
    "Run node tests/live-browser.mjs --run to launch an isolated Chrome network check.",
  );
  process.exit(0);
}
const dataDir = await mkdtemp(join(tmpdir(), "fleet-live-browser-"));
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
  if (req.url === "/help") {
    res.end("<h1>Help tab</h1>");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>Browser safety trial</title><h1>Browser safety trial</h1>
  <label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output>
  <script>
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
  await browsers.start("network-qa", { url, approved: true }, "qa");
  const action = (action, extra = {}) =>
    browsers.control("network-qa", { action, ...extra }, "qa");
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
    "Page HTTP/WebSocket requests must not bypass the exact-origin proxy",
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
  await action("newTab", { url: url + "/help" });
  let tabs = await browsers.tabs("network-qa");
  assert.equal(tabs.length, 2);
  await action("selectTab", { target: tabs[0].id });
  await assert.rejects(action("closeTab", { target: tabs[1].id }), /disabled/);
  assert.equal((await browsers.tabs("network-qa")).length, 2);
  assert.match((await action("snapshot")).output, /Local integration passed/);
  await action("reload");
  assert.match((await action("snapshot")).output, /Browser safety trial/);
  await action("viewport", { width: 390, height: 844 });
  for (let i = 0; i < 30 && browsers.frame("network-qa").width !== 390; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(browsers.frame("network-qa").width, 390);
  assert.ok((await action("screenshot")).image.length > 100);
  console.log(
    "PASS: real Chrome input, tab creation/switching, page state retained, reload, mobile stream, screenshots; unsafe tab close and page HTTP/WebSocket attempts to an unapproved localhost port blocked. No model calls.",
  );
} finally {
  await browsers.close();
  await Promise.all(
    [page, forbidden].map((server) => new Promise((r) => server.close(r))),
  );
  console.log("Retained isolated diagnostic directory: " + dataDir);
}
