import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.mjs";
import {
  browserURL,
  browserDestination,
  publicAddress,
  createBrowserProxy,
} from "../server/browser-network.mjs";
import { browserCommand } from "../server/browsers.mjs";
import { browserMcpConfig } from "../shared/browser-tools.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-browser-test-")),
    calls = [];
  const app = await createApp({
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
    browserDestination("https://other.test", ["https://example.test"], []),
    /not approved/,
  );
  const pinned = await browserDestination(
    "https://example.test/path",
    ["https://example.test"],
    [],
    async () => [{ address: "1.1.1.1", family: 4 }],
  );
  assert.equal(pinned.address, "1.1.1.1");
});
test("browser proxy enforces exact origin ports and does not follow upstream redirects", async (t) => {
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
  await assert.rejects(
    b.control(
      "project-a",
      { action: "navigate", url: "https://unapproved.test" },
      "two",
    ),
    /approve this origin/,
  );
  const state = JSON.stringify(b.state("project-a"));
  assert.ok(!state.includes("45679"));
  assert.ok(!state.includes("token"));
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
  assert.equal(b.state("project-a").controller, "human");
  await assert.rejects(
    b.agent(c.token, { action: "snapshot" }),
    /expired|revoked/,
  );
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
});
