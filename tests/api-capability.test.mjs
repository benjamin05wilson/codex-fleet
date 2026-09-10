import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:http";
import { createApp } from "../server/app.mjs";
import { CodexAuth } from "../server/auth.mjs";
import { createClient } from "../shared/client.mjs";

test("all sensitive reads, HEAD and SSE require a capability; bootstrap is minimal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-capability-"));
  const app = await createApp({
    dataDir: dir,
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const reads = [
    "/state",
    "/capabilities",
    "/search?q=secret",
    "/activity",
    "/stream",
    "/auth/status",
    "/projects/p/files",
    "/projects/p/file?path=app.js",
    "/projects/p/brain",
    "/runs/r",
    "/runs/r/diff",
    "/runs/r/files",
    "/projects/p/browser",
  ];
  for (const path of reads)
    for (const method of ["GET", "HEAD"])
      for (const headers of [{}, { "X-Fleet-Token": "invalid" }]) {
        const response = await fetch(base + path, { method, headers });
        assert.equal(response.status, 403, `${method} ${path}`);
        await response.arrayBuffer();
      }
  assert.equal((await fetch(base + "/bootstrap")).status, 403);
  for (const extra of [
    { Origin: "https://evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ])
    assert.equal(
      (
        await fetch(base + "/bootstrap", {
          headers: { "X-Fleet-Bootstrap": "1", ...extra },
        })
      ).status,
      403,
      JSON.stringify(extra),
    );
  const forged = await new Promise((resolve, reject) =>
    get(
      base + "/bootstrap",
      { headers: { Host: "evil.example", "X-Fleet-Bootstrap": "1" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on("error", reject),
  );
  assert.equal(forged, 403);
  const bootstrap = await fetch(base + "/bootstrap", {
    headers: { "X-Fleet-Bootstrap": "1" },
  });
  const value = await bootstrap.json();
  assert.deepEqual(Object.keys(value), ["csrf"]);
  assert.ok(value.csrf.length >= 32);
  assert.equal(bootstrap.headers.get("cache-control"), "no-store");
  const cookie = bootstrap.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /Path=\/api\/stream/);
  assert.equal(
    (
      await fetch(base + "/state", {
        headers: { Cookie: cookie.split(";")[0] },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/state?token=" + value.csrf)).status, 403);
  const client = createClient({ base });
  assert.ok(Array.isArray((await client.request("/state")).projects));
  app.store.event("p", null, "fixture");
  for (const headers of [
    { "X-Fleet-Token": value.csrf },
    { Cookie: cookie.split(";")[0] },
  ]) {
    const abort = new AbortController();
    const response = await fetch(base + "/stream", {
      headers,
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /event: change/);
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  assert.equal(
    (
      await fetch(base + "/native-browser/register", {
        method: "POST",
        headers: { "X-Fleet-Token": value.csrf },
        body: "{}",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/brain-agent", {
        method: "POST",
        headers: { "X-Fleet-Token": value.csrf },
        body: "{}",
      })
    ).status,
    403,
  );
});

test("client bootstrap is single-flight and a rejected mutation is never replayed", async () => {
  let bootstraps = 0,
    writes = 0;
  const client = createClient({
    fetchImpl: async (url, options) => {
      if (url.endsWith("/bootstrap")) {
        bootstraps++;
        assert.equal(options.headers["X-Fleet-Bootstrap"], "1");
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, json: async () => ({ csrf: "session" }) };
      }
      assert.equal(options.headers["X-Fleet-Token"], "session");
      if (options.method === "POST") {
        writes++;
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: "expired" }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await Promise.all([
    client.request("/search"),
    client.request("/capabilities"),
  ]);
  assert.equal(bootstraps, 1);
  await assert.rejects(client.request("/projects", "POST", {}), /expired/);
  assert.equal(writes, 1);
  await client.request("/search");
  assert.equal(bootstraps, 2);
});

// No retry masks an owned process still holding its cwd (the Windows EBUSY case).
test("app close releases auth child and stdio before its data directory is removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-capability-close-"));
  let auth;
  const app = await createApp({
    dataDir: dir,
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
    authFactory: (bin, cwd, options) =>
      (auth = new CodexAuth(bin, cwd, options)),
  });
  let closed = false;
  try {
    await auth.read(true);
    const client = auth.client;
    client.child.once("close", () => {
      closed = true;
    });
    await app.close();
    assert.equal(
      closed,
      true,
      "child close, including stdio, must precede app close",
    );
    assert.equal(client.child.stdout.destroyed, true);
    await assert.rejects(auth.connection(), /closed/);
  } finally {
    await app.close();
    app.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
