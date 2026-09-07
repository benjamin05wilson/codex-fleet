import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createBackgroundGate } from "../server/chrome-background-gate.mjs";
import { connectChromePages } from "../server/chrome-pages.mjs";

async function fixture(t) {
  const calls = [];
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const value = JSON.parse(raw);
      calls.push(value);
      const results = {
        "Target.createTarget": { targetId: "owned" },
        "Target.attachToTarget": {
          sessionId:
            value.params.targetId === "other" ? "other-session" : "session",
        },
        "Page.getFrameTree": { frameTree: { frame: { id: "main" } } },
        "Target.getTargetInfo": { targetInfo: { url: "https://example.com" } },
        "Target.getTargets": {
          targetInfos: [{ targetId: "popup", type: "page" }],
        },
        "SystemInfo.getProcessInfo": {
          processInfo: [{ id: 12345, type: "browser" }],
        },
      };
      socket.send(
        JSON.stringify({
          id: value.id,
          ...(value.method === "Browser.getWindowForTarget"
            ? { error: { message: "Browser window not found" } }
            : { result: results[value.method] || {} }),
        }),
      );
    }),
  );
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((r) => server.close(r));
  });
  return {
    calls,
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    emit(value) {
      for (const socket of server.clients) socket.send(JSON.stringify(value));
    },
  };
}

test("direct frames acknowledge all captures, filter stale/malformed frames, and restart only on target or size changes", async (t) => {
  const { calls, endpoint, emit } = await fixture(t);
  const pages = await connectChromePages(endpoint);
  t.after(() => pages.close());
  const frames = [],
    navigations = [];
  let closed = 0;
  await pages.bind("owned", 1280, 800);
  await pages.startFrames(
    (f) => frames.push(f),
    () => closed++,
    (n) => navigations.push(n),
  );
  await pages.bind("owned", 1280, 800);
  assert.equal(
    calls.filter((c) => c.method === "Page.startScreencast").length,
    1,
  );
  const frame = (
    sessionId,
    captureId,
    metadata = { deviceWidth: 1280, deviceHeight: 800 },
  ) => ({
    method: "Page.screencastFrame",
    sessionId,
    params: { sessionId: captureId, data: "aGVsbG8=", metadata },
  });
  emit(frame("session", 1));
  emit(frame("stale", 2));
  emit(frame("session", 3, {}));
  emit({ method: "Page.screencastFrame", sessionId: "session" });
  await pages.url(); // Ordered socket round trip flushes preceding events.
  await pages.url(); // Flush acknowledgements sent by those event handlers.
  assert.equal(frames.length, 1);
  assert.equal(frames[0].seq, 1);
  assert.deepEqual(
    calls
      .filter((c) => c.method === "Page.screencastFrameAck")
      .map((c) => [c.sessionId, c.params.sessionId]),
    [
      ["session", 1],
      ["stale", 2],
      ["session", 3],
    ],
  );
  await pages.bind("other", 1280, 800);
  emit(frame("session", 4));
  emit(frame("other-session", 5));
  await pages.url();
  assert.deepEqual(
    frames.map((f) => f.seq),
    [1, 2],
  );
  await pages.bind("other", 390, 844);
  const starts = calls.filter((c) => c.method === "Page.startScreencast");
  assert.equal(starts.length, 3);
  assert.deepEqual(starts.at(-1).params, {
    format: "jpeg",
    quality: 80,
    maxWidth: 390,
    maxHeight: 844,
    everyNthFrame: 1,
  });
  assert.deepEqual(
    calls
      .filter((c) => c.method === "Page.stopScreencast")
      .map((c) => c.sessionId),
    ["session", "other-session"],
  );
  assert.deepEqual(navigations, [{ clear: true }]);
  pages.close();
  pages.close();
  assert.equal(closed, 1);
});

test("direct stream tracks top-level navigation and disconnection without confusing subframes or inactive tabs", async (t) => {
  const { endpoint, emit } = await fixture(t);
  const pages = await connectChromePages(endpoint);
  t.after(() => pages.close());
  const navigations = [];
  let disconnected = 0;
  await pages.bind("owned", 1280, 800);
  await pages.startFrames(
    () => {},
    () => disconnected++,
    (n) => navigations.push(n),
  );
  for (const [sessionId, frame] of [
    [
      "session",
      { id: "child", parentId: "main", url: "https://iframe.example" },
    ],
    ["inactive", { id: "old", url: "https://old.example" }],
    ["session", { id: "main", url: "https://example.org" }],
  ])
    emit({ method: "Page.frameNavigated", sessionId, params: { frame } });
  for (const frameId of ["child", "main"])
    emit({
      method: "Page.navigatedWithinDocument",
      sessionId: "session",
      params: { frameId, url: "https://example.org/#next" },
    });
  await pages.url();
  assert.deepEqual(navigations, [
    { url: "https://example.org", clear: true },
    { url: "https://example.org/#next", clear: false },
  ]);
  emit({
    method: "Target.detachedFromTarget",
    params: { sessionId: "session" },
  });
  await pages.url();
  assert.equal(disconnected, 1);
  await assert.rejects(
    pages.input({ action: "type", text: "closed" }),
    /not ready/,
  );
});

test("private Chrome gateway forces hidden tabs before creation and suppresses activation", async (t) => {
  const { calls, endpoint } = await fixture(t);
  const targets = [];
  const gate = await createBackgroundGate(endpoint, async (target) =>
    targets.push(target),
  );
  t.after(() => gate.close());
  const client = new WebSocket(gate.endpoint);
  await once(client, "open");
  t.after(() => client.terminate());
  let id = 0;
  const call = async (method, params, sessionId) => {
    const received = once(client, "message");
    client.send(JSON.stringify({ id: ++id, method, params, sessionId }));
    return JSON.parse((await received)[0]);
  };
  await call("Target.createTarget", {
    url: "https://example.com",
    newWindow: true,
    forTab: true,
    hidden: false,
    background: false,
    windowState: "maximized",
  });
  assert.deepEqual(calls[0].params, {
    url: "https://example.com",
    hidden: true,
    background: true,
  });
  assert.deepEqual(targets, ["owned"]);
  assert.equal(
    (await call("Page.bringToFront", {}, "session")).sessionId,
    "session",
  );
  await call("Target.activateTarget", { targetId: "owned" });
  assert.equal(calls.length, 1, "activation must never reach Chrome");
  await call("Page.navigate", { url: "https://example.org" }, "session");
  assert.equal(calls[1].method, "Page.navigate");
});

test("private Chrome gateway rejects foreign paths and browser origins", async (t) => {
  const { endpoint } = await fixture(t);
  const gate = await createBackgroundGate(endpoint, async () => {});
  t.after(() => gate.close());
  for (const [url, options] of [
    [gate.endpoint + "-wrong", {}],
    [gate.endpoint, { origin: "http://evil.example" }],
  ]) {
    const client = new WebSocket(url, options);
    const result = await new Promise((resolve) => {
      client.once("open", () => resolve("open"));
      client.once("error", () => resolve("rejected"));
    });
    client.terminate();
    assert.equal(result, "rejected");
  }
});

test("persistent Chrome input binds a hidden target and never activates a native window", async (t) => {
  const { calls, endpoint } = await fixture(t);
  const pages = await connectChromePages(endpoint);
  t.after(() => pages.close());
  await assert.rejects(
    pages.input({ action: "type", text: "early" }),
    /not ready/,
  );
  assert.equal(await pages.processId(), 12345);
  await pages.createTab("about:blank", 390, 844);
  assert.deepEqual(
    calls.find((c) => c.method === "Target.createTarget").params,
    { url: "about:blank", hidden: true, background: true },
  );
  assert.equal(
    calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride").params
      .width,
    390,
  );
  await pages.input({ action: "clickPoint", x: 12, y: 34 }, 390, 844);
  await pages.input({ action: "type", text: "abc" }, 390, 844);
  await pages.input({ action: "press", text: "Backspace" }, 390, 844);
  await pages.input({ action: "wheel", deltaX: 2, deltaY: -30 }, 390, 844);
  assert.deepEqual(
    calls
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params.type),
    ["mousePressed", "mouseReleased", "mouseWheel"],
  );
  assert.ok(
    calls
      .filter((c) => c.method.startsWith("Input."))
      .every((c) => c.sessionId === "session"),
  );
  assert.equal(await pages.url(), "https://example.com");
  assert.equal(await pages.hasWindow(), false);
  assert.equal(
    calls.find((c) => c.method === "Browser.getWindowForTarget").params
      .targetId,
    "popup",
    "inspect all page targets, including untracked popups",
  );
  assert.ok(!calls.some((c) => c.method === "Page.bringToFront"));
  pages.close();
  pages.close();
  await assert.rejects(pages.url(), /closed/);
});
