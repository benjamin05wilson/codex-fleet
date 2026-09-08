import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { NativeBrowserBroker } from "../server/native-browser-broker.mjs";
import { serveBrowserMcp } from "../server/browser-mcp.mjs";

async function waitFor(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for browser fixture");
}

async function fixture(
  t,
  { commandTimeoutMs = 10000, mcpTimeoutMs = 5000 } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "fleet-browser-mcp-test-"));
  const app = await createApp({
    dataDir: directory,
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
    browserFactory: (engine) =>
      new NativeBrowserBroker(engine, { commandTimeoutMs }),
  });
  const input = new PassThrough(),
    output = new PassThrough();
  let close;
  t.after(async () => {
    close?.();
    input.destroy();
    output.destroy();
    await app.close();
    app.store.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  app.store.put("project", { id: "project", name: "Test", path: directory });
  const run = app.store.put("run", {
    id: "run",
    projectId: "project",
    status: "running",
    attempt: 1,
    worker: { identity: "worker", persistent: true },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const connection = app.browsers.connection(run, "worker");
  const desktop = app.browsers.register({
    projectId: "project",
    nativeId: randomUUID(),
  });
  const page = app.browsers.desktop(desktop.token);
  const replies = new Map();
  createInterface({ input: output }).on("line", (line) => {
    const message = JSON.parse(line);
    replies.set(message.id, message.result);
  });
  close = serveBrowserMcp({
    input,
    output,
    url: connection.url,
    capability: connection.token,
    timeoutMs: mcpTimeoutMs,
  });
  const send = (value) =>
    input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const call = (id, args = { action: "snapshot" }) =>
    send({
      id,
      method: "tools/call",
      params: { name: "fleet_browser", arguments: args },
    });
  return { app, connection, page, desktop, input, output, replies, send, call };
}

test(
  "MCP timeout cancels queued HTTP work and the same MCP connection remains usable",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { mcpTimeoutMs: 300 });
    f.call(1, { action: "scroll", text: "down" });
    await waitFor(() => f.page.queue.length === 1);
    await waitFor(() => f.replies.has(1));
    assert.equal(f.replies.get(1).isError, true);
    assert.match(f.replies.get(1).content[0].text, /timed out/);
    await waitFor(() => f.page.queue.length === 0);
    assert.equal(f.page.current, null);
    assert.equal(f.app.browsers.desktop(f.desktop.token), f.page);
    const next = f.app.browsers.next(
      f.desktop.token,
      new AbortController().signal,
    );
    f.call(2);
    const command = await next;
    assert.equal(command.input.action, "snapshot");
    f.app.browsers.result(f.desktop.token, {
      id: command.id,
      result: { text: "same page" },
    });
    await waitFor(() => f.replies.has(2));
    assert.equal(f.replies.get(2).isError, false);
  },
);

test("MCP cancellation notification removes a queued launcher reveal and preserves the connection", async (t) => {
  const f = await fixture(t);
  const launcher = f.app.browsers.registerLauncher({ nativeId: randomUUID() });
  const opener = f.app.browsers.desktop(launcher.token);
  f.call(1);
  await waitFor(() => opener.queue.length === 1);
  f.send({ method: "notifications/cancelled", params: { requestId: 1 } });
  await waitFor(() => opener.queue.length === 0);
  assert.equal(f.page.queue.length, 0);
  assert.equal(opener.current, null);
  f.send({ id: 2, method: "ping" });
  await waitFor(() => f.replies.has(2));
  assert.deepEqual(f.replies.get(2), {});
});

test("MCP disconnect after dispatch keeps the active barrier until the late native result", async (t) => {
  const f = await fixture(t);
  const next = f.app.browsers.next(
    f.desktop.token,
    new AbortController().signal,
  );
  f.call(1, { action: "scroll", text: "down" });
  const command = await next;
  let cancelled = false;
  const reject = f.page.current.reject;
  f.page.current.reject = (error) => {
    cancelled = error.status === 499;
    reject(error);
  };
  f.input.end();
  // Observe the HTTP cancellation before submitting another agent's action.
  await waitFor(() => cancelled);
  const fresh = f.app.browsers.agent(f.connection.token, {
    action: "snapshot",
  });
  assert.equal(f.page.current.id, command.id);
  assert.equal(f.page.queue.length, 1);
  const following = f.app.browsers.next(
    f.desktop.token,
    new AbortController().signal,
  );
  f.app.browsers.result(f.desktop.token, {
    id: command.id,
    result: { scrolled: true },
  });
  const second = await following;
  assert.equal(second.input.action, "snapshot");
  assert.notEqual(second.id, command.id);
  f.app.browsers.result(f.desktop.token, {
    id: second.id,
    result: { text: "same page" },
  });
  assert.deepEqual(await fresh, { text: "same page" });
  assert.equal(f.app.browsers.desktop(f.desktop.token), f.page);
});

for (const disconnect of ["stdin EOF", "stdout close"]) {
  test(
    disconnect + " aborts pending MCP fetches and removes queued page actions",
    async (t) => {
      const f = await fixture(t);
      f.call(1);
      await waitFor(() => f.page.queue.length === 1);
      if (disconnect === "stdin EOF") f.input.end();
      else f.output.destroy();
      await waitFor(() => f.page.queue.length === 0);
      assert.equal(f.page.current, null);
      assert.equal(f.app.browsers.desktop(f.desktop.token), f.page);
    },
  );
}

test("broker HTTP deadline cancels work even when the caller stays connected", async (t) => {
  const f = await fixture(t, { commandTimeoutMs: 100 });
  const response = await fetch(f.connection.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + f.connection.token,
    },
    body: JSON.stringify({ action: "snapshot" }),
  });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /timed out/);
  assert.equal(f.page.queue.length, 0);
  assert.equal(f.app.browsers.desktop(f.desktop.token), f.page);
});

test(
  "terminating a real stdio MCP child cancels its queued request without replay",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../server/browser-mcp.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          FLEET_BROWSER_URL: f.connection.url,
          FLEET_BROWSER_CAPABILITY: f.connection.token,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fleet_browser",
          arguments: { action: "scroll", text: "down" },
        },
      }) + "\n",
    );
    await waitFor(() => f.page.queue.length === 1);
    child.kill();
    await exited;
    await waitFor(() => f.page.queue.length === 0);
    assert.equal(f.page.current, null);
    assert.equal(f.app.browsers.desktop(f.desktop.token), f.page);
  },
);
