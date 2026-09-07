import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.mjs";
import {
  browserURL,
  browserDestination,
  publicAddress,
  createBrowserProxy,
} from "../server/browser-network.mjs";
import { browserCommand, Browsers } from "../server/browsers.mjs";
import {
  browserMcpConfig,
  browserStartupConfig,
  browserInstructions,
  verifyBrowserTool,
  browserTool,
} from "../shared/browser-tools.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-browser-test-")),
    calls = [];
  const app = await createApp({
    // Historical controller tests inject their own service. There is no
    // runtime flag or UI option for enabling the retired browser.
    browserFactory: (engine, options) => new Browsers(engine, options),
    dataDir: root,
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
    browserOptions: {
      proxyFactory: async () => ({ port: 45678, close: async () => {} }),
      driver: async (s, args) => {
        calls.push(args);
        if (args[0] === "get") return { url: s.url };
        if (args[0] === "snapshot")
          return { snapshot: '- button "Submit" [ref=e1]' };
        if (args[0] === "stream") return { port: 45679 };
        return { ok: true };
      },
    },
  });
  app.store.put("project", { id: "project-a", name: "Browser QA", path: root });
  app.store.put("run", {
    id: "run-a",
    projectId: "project-a",
    status: "draft",
    title: "QA",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, calls, base: `http://127.0.0.1:${app.server.address().port}` };
}
test("browser URL policy blocks unsafe schemes, credentials, internal ports and private DNS", async () => {
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "http://127.0.0.1:4317",
    "http://2130706433:4317",
  ])
    assert.throws(() => browserURL(value, [4317]));
  assert.equal(
    browserURL("http://localhost:3000", [4317]).origin,
    "http://localhost:3000",
  );
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
  await assert.rejects(
    browserDestination(
      "https://example.test",
      ["https://example.test"],
      [],
      async () => [{ address: "127.0.0.1", family: 4 }],
    ),
    /Private/,
  );
  await assert.rejects(
    browserDestination("http://localhost:3001", ["http://localhost:3000"], []),
    /selected local preview/,
  );
  const pinned = await browserDestination(
    "https://other.test/path",
    [],
    [],
    async () => [{ address: "1.1.1.1", family: 4 }],
  );
  assert.equal(pinned.address, "1.1.1.1");
});
test("browser proxy protects local ports and does not follow upstream redirects", async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/redirect")
      res.writeHead(302, { Location: "http://127.0.0.1:4317/api/state" }).end();
    else res.end("allowed");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await createBrowserProxy([origin], [4317]);
  t.after(async () => {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  });
  const request = (path) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: proxy.port, path }, (r) => {
          let body = "";
          r.on("data", (d) => (body += d));
          r.on("end", () =>
            resolve({
              status: r.statusCode,
              body,
              location: r.headers.location,
            }),
          );
        })
        .on("error", reject);
    });
  assert.equal((await request(origin)).body, "allowed");
  assert.equal((await request("http://127.0.0.1:4317/api/state")).status, 403);
  assert.equal((await request("https://example.com")).status, 403);
  assert.equal((await request(origin + "/redirect")).status, 302);
});
test("browser proxy handles socket resets during CONNECT and WebSocket policy checks", async (t) => {
  let server;
  const createServer = http.createServer;
  t.mock.method(
    http,
    "createServer",
    (...args) => (server = createServer(...args)),
  );
  const proxy = await createBrowserProxy(["http://127.0.0.1:3000"], [4317]);
  t.after(() => proxy.close());
  for (const event of ["connect", "upgrade"]) {
    const handled = new Promise((resolve, reject) => {
      server.once(event, (_req, socket) => {
        try {
          // Node hands upgraded sockets to the application. A reset can arrive
          // before the asynchronous destination-policy check has completed.
          assert.ok(
            socket.listenerCount("error") > 0,
            `${event} needs an immediate error listener`,
          );
          socket.emit(
            "error",
            Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          );
          resolve();
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
    });
    const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
    socket.on("error", () => {});
    socket.on("connect", () =>
      socket.write(
        event === "connect"
          ? "CONNECT unapproved.invalid:443 HTTP/1.1\r\nHost: unapproved.invalid:443\r\n\r\n"
          : "GET http://unapproved.invalid/ HTTP/1.1\r\nHost: unapproved.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      ),
    );
    try {
      await handled;
    } finally {
      socket.destroy();
    }
  }
});
test("browser command vocabulary rejects raw code, shell arguments and invalid references", () => {
  for (const input of [
    { action: "eval", text: "process.exit()" },
    { action: "click", target: "--help" },
    { action: "fill", target: "body", text: "a" },
    { action: "press", text: "--cdp" },
    { action: "viewport", width: 9000, height: 9000 },
    { action: "snapshot", args: ["--profile", "Default"] },
  ])
    assert.throws(() => browserCommand(input));
  assert.deepEqual(browserCommand({ action: "click", target: "@e23" }), [
    "click",
    "@e23",
  ]);
  assert.deepEqual(
    browserCommand({ action: "fill", target: "@e1", text: "$(touch nope)" }),
    ["fill", "@e1", "$(touch nope)"],
  );
});
test("browser starts only with consent and preserves explicit controller ownership", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  assert.equal(b.state("project-a").status, "closed");
  assert.equal(calls.length, 0);
  await assert.rejects(
    b.start("project-a", { url: "https://example.com" }, "one"),
    /Approve/,
  );
  await b.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  assert.equal(b.state("project-a", "one").canControl, true);
  assert.equal(b.state("project-a", "two").canControl, false);
  await assert.rejects(
    b.start("project-a", { url: "https://example.com", approved: true }, "one"),
    /already/,
  );
  await assert.rejects(
    b.control("project-a", { action: "snapshot" }, "two"),
    /Take control/,
  );
  b.take("project-a", "two");
  await b.control("project-a", { action: "snapshot" }, "two");
  for (const action of ["navigate", "newTab"])
    await b.control(
      "project-a",
      { action, url: "https://another-public.test" },
      "two",
    );
  await assert.rejects(
    b.control(
      "project-a",
      { action: "navigate", url: "http://localhost:3001" },
      "two",
    ),
    /selected local preview/,
  );
  const state = JSON.stringify(b.state("project-a"));
  assert.ok(!state.includes("45679"));
  assert.ok(!state.includes("token"));
});

test("fast Chrome input keeps ownership and validation in front of CDP", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  await b.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  const inputs = [];
  b.sessions.get("project-a").native = {
    background: true,
    close: async () => {},
    pages: {
      input: async (input) => {
        inputs.push(input);
        return {};
      },
      url: async () => "https://example.com",
    },
  };
  calls.length = 0;
  for (const input of [
    { action: "type", text: "abc" },
    { action: "clickPoint", x: 20, y: 40 },
    { action: "wheel", deltaX: 4, deltaY: 30 },
    { action: "press", text: "Backspace" },
  ])
    await b.control("project-a", input, "one");
  assert.equal(inputs.length, 4);
  assert.equal(calls.length, 0, "hot input must not fork a CLI process");
  for (const input of [
    { action: "type", text: "x".repeat(4001) },
    { action: "clickPoint", x: -1, y: 0 },
    { action: "wheel", deltaX: 0, deltaY: 1501 },
    { action: "wheel", deltaX: NaN, deltaY: 1 },
    { action: "press", text: "F12" },
  ])
    await assert.rejects(b.control("project-a", input, "one"));
  await assert.rejects(
    b.control("project-a", { action: "type", text: "blocked" }, "two"),
  );
  assert.equal(inputs.length, 4);
});
test("legacy domain lists cannot grant extra local access", async (t) => {
  const { app } = await fixture(t);
  let proxyOrigins;
  app.browsers.proxyFactory = async (origins) => {
    proxyOrigins = origins;
    return { port: 45678, close: async () => {} };
  };
  await app.browsers.start(
    "project-a",
    {
      url: "http://localhost:3000",
      origins: ["http://localhost:3001", "https://example.com"],
      approved: true,
    },
    "one",
  );
  assert.deepEqual(proxyOrigins, ["http://localhost:3000"]);
  for (const action of ["navigate", "newTab"]) {
    await app.browsers.control(
      "project-a",
      {
        action,
        url: "http://localhost:3000/preview",
      },
      "one",
    );
    await app.browsers.control(
      "project-a",
      {
        action,
        url: "https://not-listed.test",
      },
      "one",
    );
    await assert.rejects(
      app.browsers.control(
        "project-a",
        {
          action,
          url: "http://localhost:3001",
        },
        "one",
      ),
      /selected local preview/,
    );
  }
});
test("individual tab closing is blocked before the native command can reset other tabs", async (t) => {
  const { app } = await fixture(t),
    b = app.browsers;
  await b.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  let calls = 0;
  b.driver = async () => {
    calls++;
    return {};
  };
  await assert.rejects(
    b.control("project-a", { action: "closeTab", target: "t1" }, "one"),
    /disabled/,
  );
  assert.equal(calls, 0);
});
test("visible and headless launches omit domain filtering and reject unsafe persistence options", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  const input = { url: "https://example.com", approved: true };
  for (const extra of [
    { mode: "stealth" },
    { keepOpen: "true" },
    { profile: "Default" },
    { restore: true },
    { args: "--disable-web-security" },
    { headed: true },
  ])
    await assert.rejects(b.start("project-a", { ...input, ...extra }, "one"));
  assert.equal(calls.length, 0);
  for (const mode of [undefined, "headless"]) {
    const state = await b.start(
      "project-a",
      { ...input, ...(mode ? { mode } : {}) },
      "one",
    );
    const config = JSON.parse(
      await readFile(b.sessions.get("project-a").config, "utf8"),
    );
    assert.equal(state.mode, mode || "visible");
    assert.equal(state.canControl, true);
    assert.equal(config.headed, mode !== "headless");
    assert.equal(Object.hasOwn(config, "headless"), false);
    assert.equal(config.engine, "chrome");
    assert.equal(config.restoreSave, "never");
    assert.equal(Object.hasOwn(config, "allowedDomains"), false);
    assert.equal(Object.hasOwn(state, "origins"), false);
    assert.equal(state.domainFiltering, false);
    assert.match(config.proxy, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(config.proxyBypass, "<-loopback>");
    for (const option of [
      "profile",
      "restore",
      "state",
      "cdp",
      "userAgent",
      "initScripts",
    ])
      assert.equal(Object.hasOwn(config, option), false);
    await b.stop("project-a");
  }
});
test("keep-open survives idle expiry but never shutdown, and takeover retains the native session", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  const input = { url: "https://example.com", approved: true };
  await b.start("project-a", input, "one");
  await b.expireIdle(Date.now() + 31 * 60 * 1000);
  assert.equal(b.state("project-a").status, "closed");
  await b.start("project-a", { ...input, keepOpen: true }, "one");
  const session = b.sessions.get("project-a");
  await b.expireIdle(Date.now() + 31 * 60 * 1000);
  assert.equal(b.state("project-a").status, "open");
  const before = calls.length;
  b.grant("project-a", "run-a", "one", true);
  b.take("project-a", "one");
  assert.equal(b.sessions.get("project-a"), session);
  assert.equal(
    calls.length,
    before,
    "Takeover must not relaunch Chrome or clear login state",
  );
  await b.close();
  assert.equal(b.sessions.size, 0);
  assert.ok(calls.some((args) => args[0] === "close"));
});
test("agent capability is attempt-scoped, approval-gated and immediately revocable", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  await b.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  b.grant("project-a", "run-a", "one", true);
  const connection = b.connection(app.store.get("run", "run-a"), "attempt-1");
  app.store.patch("run", "run-a", {
    status: "running",
    worker: { identity: "attempt-1" },
  });
  await b.agent(connection.token, { action: "snapshot" });
  const before = calls.length;
  const pending = b.agent(connection.token, { action: "click", target: "@e1" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, before);
  const approval = b.state("project-a").pending;
  assert.equal(approval.action, "click");
  b.approve("project-a", { id: approval.id, approved: true }, "one");
  await pending;
  assert.ok(calls.some((args) => args[0] === "click"));
  const denied = b.agent(connection.token, {
    action: "fill",
    target: "@e1",
    text: "test",
  });
  const denial = assert.rejects(denied, /denied/);
  await new Promise((r) => setTimeout(r, 0));
  b.approve(
    "project-a",
    { id: b.state("project-a").pending.id, approved: false },
    "one",
  );
  await denial;
  const waiting = b.agent(connection.token, { action: "click", target: "@e1" });
  const revoked = assert.rejects(waiting, /revoked/);
  await new Promise((r) => setTimeout(r, 0));
  b.take("project-a", "two");
  await revoked;
  await assert.rejects(
    b.agent(connection.token, { action: "snapshot" }),
    /expired|revoked/,
  );
  await b.stop("project-a");
  assert.equal(b.state("project-a").status, "closed");
});
test("completed or changed worker attempts cannot reuse browser capabilities", async (t) => {
  const { app } = await fixture(t),
    b = app.browsers;
  await b.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  b.grant("project-a", "run-a", "one", true);
  const c = b.connection(app.store.get("run", "run-a"), "one");
  app.store.patch("run", "run-a", {
    status: "running",
    worker: { identity: "two" },
  });
  await assert.rejects(b.agent(c.token, { action: "snapshot" }), /attempt/);
  app.store.patch("run", "run-a", { status: "review" });
  assert.equal(b.state("project-a").controller, "agent");
  assert.equal(b.state("project-a").agentRunId, "run-a");
  await assert.rejects(
    b.agent(c.token, { action: "snapshot" }),
    /expired|revoked/,
  );
  const next = b.connection(app.store.get("run", "run-a"), "next");
  app.store.patch("run", "run-a", {
    status: "running",
    worker: { identity: "next" },
  });
  await b.agent(next.token, { action: "snapshot" });
});
test("browser API requires CSRF on reads and writes, rejects foreign origins and invalid agent tokens", async (t) => {
  const { app, base } = await fixture(t);
  const state = await fetch(base + "/api/state").then((r) => r.json());
  const endpoint = base + "/api/projects/project-a/browser";
  assert.equal((await fetch(endpoint)).status, 403);
  const headers = {
    "x-fleet-token": state.csrf,
    "x-fleet-client": "test",
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  assert.equal(
    (
      await fetch(endpoint, {
        headers: { ...headers, Origin: "https://attacker.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/browser-agent", {
        method: "POST",
        headers: { Authorization: "Bearer invalid" },
        body: JSON.stringify({ action: "snapshot" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint + "/start", {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "http://127.0.0.1:" + app.server.address().port,
          approved: true,
        }),
      })
    ).status,
    400,
  );
});
test("frame streaming requires browser credentials and releases listeners on disconnect", async (t) => {
  const { app, base } = await fixture(t);
  const state = await fetch(base + "/api/state").then((r) => r.json());
  const url = base + "/api/projects/project-a/browser/frames";
  assert.equal((await fetch(url)).status, 403);
  await app.browsers.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  const response = await fetch(url, {
    headers: { "x-fleet-token": state.csrf, "x-fleet-client": "one" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const reader = response.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /"image":null/,
  );
  const session = app.browsers.sessions.get("project-a");
  for (const listener of session.frameListeners)
    listener({ image: "frame", seq: 2 });
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /"seq":2/,
  );
  await reader.cancel();
  for (let i = 0; i < 20 && session.frameListeners.size; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.frameListeners.size, 0);
});
test("large frames are sent once and drain only flushes the newest unsent frame", async (t) => {
  const { app } = await fixture(t),
    b = app.browsers;
  await b.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  const session = b.sessions.get("project-a");
  const frame = (seq) => ({
    image: "data:image/jpeg;base64," + "A".repeat(110000),
    seq,
    width: 1280,
    height: 800,
  });
  session.frame = frame(1);
  const response = new EventEmitter(),
    writes = [];
  response.writeHead = () => {};
  response.write = (value) => {
    writes.push(value);
    return false;
  };
  response.end = () => response.emit("finish");
  b.streamFrames("project-a", response);
  t.after(() => response.emit("close"));
  assert.equal(writes.length, 1);
  response.emit("drain");
  assert.equal(writes.length, 1, "draining a sent frame must not resend it");
  const publish = (value) => {
    if (value.image) session.frame = value;
    for (const listener of session.frameListeners) listener(value);
  };
  publish(frame(2));
  publish(frame(3));
  publish(frame(4));
  assert.equal(writes.length, 2);
  response.emit("drain");
  assert.equal(writes.length, 3);
  assert.equal(
    JSON.parse(writes[2]).seq,
    4,
    "drop stale unsent frames under backpressure",
  );
  response.emit("drain");
  response.emit("drain");
  assert.equal(writes.length, 3);
  publish(frame(5));
  publish({ refresh: true });
  publish(frame(6));
  response.emit("drain");
  response.emit("drain");
  response.emit("drain");
  assert.equal(
    writes.filter((v) => JSON.parse(v).refresh).length,
    1,
    "approval refresh survives frame coalescing",
  );
  assert.equal(JSON.parse(writes.at(-1)).seq, 6);
  response.emit("close");
  assert.equal(session.frameListeners.size, 0);
});

test("real HTTP large-frame delivery does not flood a client with cached images", async (t) => {
  const { app, base } = await fixture(t);
  await app.browsers.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  const session = app.browsers.sessions.get("project-a");
  session.frame = {
    image: "data:image/jpeg;base64," + "A".repeat(110000),
    seq: 1,
  };
  const state = await (await fetch(base + "/api/state")).json();
  const controller = new AbortController();
  const response = await fetch(
    base + "/api/projects/project-a/browser/frames",
    {
      headers: { "x-fleet-token": state.csrf, "x-fleet-client": "one" },
      signal: controller.signal,
    },
  );
  const reader = response.body.getReader();
  let buffer = "",
    bytes = 0;
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      assert.ok(
        bytes < 300000,
        "a stationary page must not continuously resend a 110KB frame",
      );
      buffer += new TextDecoder().decode(value);
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  assert.equal(buffer.trim().split("\n").length, 1);
  assert.equal(JSON.parse(buffer.trim()).seq, 1);
});

test("typing and scrolling avoid redundant native URL lookups", async (t) => {
  const { app, calls } = await fixture(t);
  await app.browsers.start(
    "project-a",
    { url: "https://example.com", approved: true },
    "one",
  );
  calls.length = 0;
  await app.browsers.control(
    "project-a",
    { action: "type", text: "hello" },
    "one",
  );
  await app.browsers.control(
    "project-a",
    { action: "scroll", text: "down" },
    "one",
  );
  assert.deepEqual(calls, [
    ["keyboard", "type", "hello"],
    ["scroll", "down", "400"],
  ]);
});
test("browser routing shares native access automatically and missing tools fail closed", async () => {
  assert.match(browserTool.description, /same native project browser/);
  assert.match(browserInstructions(false), /This chat has no browser tool/);
  assert.match(browserInstructions(true), /never fall back/);
  const requests = [];
  await verifyBrowserTool(
    {
      request: async (method, params) => {
        requests.push({ method, params });
        return params.cursor
          ? {
              data: [
                {
                  name: "fleet_browser",
                  tools: { fleet_browser: { name: "fleet_browser" } },
                },
              ],
            }
          : { data: [], nextCursor: "page2" };
      },
    },
    "thread-a",
  );
  assert.equal(requests[1].params.cursor, "page2");
  assert.equal(requests[0].params.threadId, "thread-a");
  await assert.rejects(
    verifyBrowserTool({ request: async () => ({ data: [] }) }, "thread-a"),
    /did not connect/,
  );
});
test("MCP connection override carries only the dedicated scoped adapter, without experimental tools", () => {
  assert.deepEqual(browserMcpConfig(null), {});
  const result = browserMcpConfig({
    node: "node",
    script: "/browser-mcp.mjs",
    url: "http://localhost:1/api/browser-agent",
    token: "capability",
  });
  assert.equal(
    result.config["mcp_servers.fleet_browser"].env.FLEET_BROWSER_CAPABILITY,
    "capability",
  );
  assert.equal(result.dynamicTools, undefined);
  assert.equal(result.config["mcp_servers.fleet_browser"].required, true);
});

test("browser startup config supports resumed worker processes without putting capabilities in argv", () => {
  const config = browserStartupConfig({
    node: "node",
    script: "/fixture.mjs",
    url: "http://127.0.0.1:1/api/browser-agent",
    token: "private-fixture-token",
  });
  assert.equal(config.env.FLEET_BROWSER_CAPABILITY, "private-fixture-token");
  assert.equal(
    config.args.some((arg) => arg.includes("private-fixture-token")),
    false,
  );
  assert.ok(
    config.args.includes(
      'mcp_servers.fleet_browser.default_tools_approval_mode="auto"',
    ),
  );
  assert.deepEqual(browserStartupConfig(null), { args: [], env: {} });
});
test("worker connects the shared browser before fresh and resumed fixture turns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-worker-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const threadId of [undefined, "fixture-existing"]) {
    const directory = await mkdtemp(join(root, "attempt-"));
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        identity: "fixture-identity",
        bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
        run: { worktree: directory, sandbox: "workspace-write", threadId },
        prompt: "TEST_POLICY",
        browser: {
          node: process.execPath,
          script: "/fixture-only.mjs",
          url: "http://127.0.0.1:1",
          token: "fixture-only",
        },
      }),
    );
    await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        [
          fileURLToPath(new URL("../server/worker.mjs", import.meta.url)),
          directory,
        ],
        { cwd: directory, timeout: 10000 },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    const policy = JSON.parse(
      await readFile(join(directory, "policy.json"), "utf8"),
    );
    assert.equal(
      policy.thread.config["mcp_servers.fleet_browser"].required,
      true,
    );
    assert.equal(policy.thread.config["mcp_servers.cua_repl"].enabled, false);
    assert.match(policy.thread.developerInstructions, /automatically shared/);
    assert.equal(
      policy.thread.config["mcp_servers.fleet_browser"]
        .default_tools_approval_mode,
      "auto",
    );
    if (threadId) assert.equal(policy.thread.threadId, threadId);
    const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).event);
    const connected = events.findIndex(
      (e) => e.phase === "Connecting project browser",
    );
    assert.ok(
      connected >= 0 &&
        connected < events.findIndex((e) => e.type === "turn.started"),
    );
  }
});
test("owned Chrome frames feed the authenticated broker and clear on navigation or disconnect", async (t) => {
  const { app } = await fixture(t),
    b = app.browsers;
  let frame, disconnect, navigate;
  const driver = b.driver;
  b.driver = (s, args) =>
    args[0] === "tab"
      ? { tabs: [{ active: true, targetId: "owned" }] }
      : driver(s, args);
  b.nativeLauncher = async () => ({
    endpoint: "ws://127.0.0.1:45680/devtools/browser/private",
    port: 45680,
    background: true,
    alive: () => true,
    pages: {
      bind: async () => {},
      startFrames: async (onFrame, onError, onNavigate) => {
        frame = onFrame;
        disconnect = onError;
        navigate = onNavigate;
      },
    },
    close: async () => disconnect?.(),
  });
  await b.start(
    "project-a",
    {
      url: "https://example.com",
      approved: true,
      mode: "attached",
      experimentalApproved: true,
    },
    "one",
  );
  const session = b.sessions.get("project-a"),
    delivered = [];
  session.frameListeners.add((v) => delivered.push(v));
  assert.equal(
    session.socket,
    undefined,
    "owned frames must not use a second native stream socket",
  );
  const value = {
    data: "aGVsbG8=",
    seq: 1,
    metadata: {
      deviceWidth: 1280,
      deviceHeight: 800,
      timestamp: 100,
      scrollOffsetY: 20,
    },
  };
  frame(value);
  assert.equal(b.frame("project-a").image, "data:image/jpeg;base64,aGVsbG8=");
  assert.equal(b.frame("project-a").capturedAt, 100000);
  navigate({ url: "https://example.org/#section", clear: false });
  assert.equal(
    b.frame("project-a").seq,
    1,
    "same-document navigation retains its live frame",
  );
  navigate({ url: "https://example.org/next", clear: true });
  assert.equal(b.frame("project-a").image, null);
  assert.equal(b.state("project-a").url, "https://example.org/next");
  frame({ ...value, seq: 2 });
  disconnect();
  assert.equal(b.frame("project-a").image, null);
  assert.match(b.state("project-a").error, /connection closed/);
  assert.ok(
    delivered.some((v) => v.refresh),
    "a lost connection must refresh controls",
  );
  assert.doesNotMatch(JSON.stringify(b.state("project-a")), /45680|devtools/);
  await b.stop("project-a");
  frame(value);
  assert.equal(
    session.frame,
    null,
    "late frames must not resurrect disposed state",
  );
});

test("experimental attachment needs separate consent, owns its process and never leaks its endpoint", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  let launched = 0,
    closed = 0,
    launchInput,
    onExit,
    alive = true;
  b.nativeLauncher = async (input) => {
    launched++;
    launchInput = input;
    onExit = input.onExit;
    return {
      endpoint: "ws://127.0.0.1:45680/devtools/browser/owned-test",
      port: 45680,
      alive: () => alive,
      close: async () => {
        closed++;
        alive = false;
      },
    };
  };
  const input = {
    url: "https://example.com",
    approved: true,
    mode: "attached",
  };
  await assert.rejects(b.start("project-a", input, "qa"), /acknowledge/);
  assert.equal(launched, 0);
  await b.start("project-a", { ...input, experimentalApproved: true }, "qa");
  assert.equal(launched, 1);
  assert.equal(launchInput.proxyPort, 45678);
  assert.ok(launchInput.excludedPorts.includes(443));
  assert.ok(launchInput.excludedPorts.includes(4317));
  const config = JSON.parse(
    await readFile(b.sessions.get("project-a").config, "utf8"),
  );
  assert.equal(config.cdp, "ws://127.0.0.1:45680/devtools/browser/owned-test");
  assert.equal(config.pinTab, true);
  assert.equal(Object.hasOwn(config, "allowedDomains"), false);
  assert.equal(Object.hasOwn(config, "profile"), false);
  assert.ok(b.forbidden().includes(45680));
  assert.doesNotMatch(
    JSON.stringify(b.state("project-a", "qa")),
    /owned-test|45680|chrome-profile/,
  );
  await assert.rejects(
    b.control(
      "project-a",
      { action: "navigate", url: "http://127.0.0.1:45680" },
      "qa",
    ),
    /internal/,
  );
  b.grant("project-a", "run-a", "qa", true);
  const connection = b.connection(app.store.get("run", "run-a"), "attempt");
  app.store.patch("run", "run-a", {
    status: "running",
    worker: { identity: "attempt" },
  });
  const pending = b.agent(connection.token, { action: "click", target: "@e1" });
  const rejected = assert.rejects(pending, /revoked/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  alive = false;
  onExit();
  await rejected;
  assert.equal(b.state("project-a").status, "failed");
  const count = calls.length;
  await assert.rejects(
    b.control("project-a", { action: "snapshot" }, "qa"),
    /Open/,
  );
  assert.equal(
    calls.length,
    count,
    "A closed Chrome must not silently restart",
  );
  assert.equal(launched, 1);
  await b.stop("project-a");
  assert.equal(closed, 1);
});
test("attachment launch failure closes the proxy and never falls back to another mode", async (t) => {
  const { app, calls } = await fixture(t),
    b = app.browsers;
  let proxyClosed = 0;
  b.proxyFactory = async () => ({
    port: 45678,
    close: async () => proxyClosed++,
  });
  b.nativeLauncher = async () => {
    throw new Error("Chrome unavailable");
  };
  await assert.rejects(
    b.start(
      "project-a",
      {
        url: "https://example.com",
        approved: true,
        mode: "attached",
        experimentalApproved: true,
      },
      "qa",
    ),
    /Chrome unavailable/,
  );
  assert.equal(b.sessions.size, 0);
  assert.equal(proxyClosed, 1);
  assert.equal(
    calls.some((args) => args[0] === "open"),
    false,
  );
});
test("browser API round-trips explicit mode and keep-open without enabling profile import", async (t) => {
  const { base, app } = await fixture(t);
  app.browsers.nativeLauncher = async () => ({
    endpoint: "ws://127.0.0.1:45680/devtools/browser/owned",
    port: 45680,
    alive: () => true,
    close: async () => {},
  });
  const state = await fetch(base + "/api/state").then((r) => r.json());
  const endpoint = base + "/api/projects/project-a/browser";
  const headers = {
    "x-fleet-token": state.csrf,
    "x-fleet-client": "qa",
    "Content-Type": "application/json",
  };
  const post = (action, input) =>
    fetch(endpoint + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  assert.equal(
    (
      await post("start", {
        url: "https://example.com",
        approved: true,
        mode: "attached",
      })
    ).status,
    400,
  );
  for (const mode of ["visible", "headless", "attached"]) {
    const response = await post("start", {
      url: "https://example.com",
      approved: true,
      mode,
      keepOpen: true,
      ...(mode === "attached" ? { experimentalApproved: true } : {}),
    });
    assert.equal(response.status, 200);
    const opened = await response.json();
    assert.equal(opened.mode, mode);
    assert.equal(opened.keepOpen, true);
    assert.equal(opened.canControl, true);
    assert.equal((await post("stop", {})).status, 200);
  }
  assert.equal(
    (
      await post("start", {
        url: "https://example.com",
        approved: true,
        profile: "Default",
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(endpoint, { headers }).then((r) => r.json())).status,
    "closed",
  );
});
