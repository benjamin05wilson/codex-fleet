import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { NativeBrowserBroker } from "../server/native-browser-broker.mjs";
import { browserInstructions } from "../shared/browser-tools.mjs";

test("the product daemon uses the native broker and rejects retired launch, sharing and stream endpoints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-native-only-test-"));
  const app = await createApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.ok(app.browsers instanceof NativeBrowserBroker);
  assert.equal(app.engine.browsers.connection({ id: "run" }, {}), null);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const state = await (await fetch(origin + "/api/state")).json();
  assert.equal(state.browserMode, "native");
  assert.equal(state.browserAvailable, false);
  assert.equal(state.browserAgentAvailable, true);
  assert.equal(state.browserAutoOpenAvailable, false);
  const headers = {
    "x-fleet-token": state.csrf,
    "x-fleet-client": "native-only-test",
    "content-type": "application/json",
  };
  for (const action of ["start", "grant", "take", "approve", "control"]) {
    const result = await fetch(
      origin + "/api/projects/project/browser/" + action,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(result.status, 410, action);
    assert.match((await result.json()).error, /shared native desktop browser/);
  }
  for (const action of ["frame", "frames", "tabs"]) {
    const result = await fetch(
      origin + "/api/projects/project/browser/" + action,
      { headers },
    );
    assert.equal(result.status, 410, action);
    await result.json();
  }
  const agent = await fetch(origin + "/api/browser-agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(agent.status, 403);
  await agent.json();
  const read = await (
    await fetch(origin + "/api/projects/project/browser", { headers })
  ).json();
  assert.equal(read.mode, "native");
  assert.equal(read.available, true);
  assert.match(browserInstructions(true), /automatically shared/);
  assert.doesNotMatch(
    browserInstructions(false),
    /Let this chat browse|Share browser/,
  );
  app.store.put("project", {
    id: "native-auth",
    name: "Native auth test",
    path: directory,
  });
  const registration = { projectId: "native-auth", nativeId: randomUUID() };
  for (const deniedHeaders of [
    { "content-type": "application/json" },
    { ...headers, Origin: "https://untrusted.example" },
  ]) {
    const denied = await fetch(origin + "/api/native-browser/register", {
      method: "POST",
      headers: deniedHeaders,
      body: JSON.stringify(registration),
    });
    assert.equal(denied.status, 403);
    await denied.json();
    const deniedLauncher = await fetch(
      origin + "/api/native-browser/launcher-register",
      {
        method: "POST",
        headers: deniedHeaders,
        body: JSON.stringify({ nativeId: randomUUID() }),
      },
    );
    assert.equal(deniedLauncher.status, 403);
    await deniedLauncher.json();
  }
  const launcher = await fetch(
    origin + "/api/native-browser/launcher-register",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ nativeId: randomUUID() }),
    },
  );
  assert.equal(launcher.status, 200);
  const launcherToken = (await launcher.json()).token;
  assert.equal(launcherToken.length, 64);
  assert.equal(
    (await (await fetch(origin + "/api/state")).json())
      .browserAutoOpenAvailable,
    true,
  );
  const registered = await fetch(origin + "/api/native-browser/register", {
    method: "POST",
    headers,
    body: JSON.stringify(registration),
  });
  assert.equal(registered.status, 200);
  const { token } = await registered.json();
  assert.equal(token.length, 64);
  assert.equal(
    JSON.stringify(app.browsers.state("native-auth")).includes(token),
    false,
  );
  const forged = await fetch(origin + "/api/native-browser/result", {
    method: "POST",
    headers,
    body: JSON.stringify({ token: "wrong", id: randomUUID(), result: {} }),
  });
  assert.equal(forged.status, 403);
  await forged.json();
  const stale = await fetch(origin + "/api/native-browser/result", {
    method: "POST",
    headers,
    body: JSON.stringify({ token, id: randomUUID(), result: {} }),
  });
  assert.equal(stale.status, 409);
  await stale.json();
  const closed = await fetch(origin + "/api/native-browser/close", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
  assert.equal(closed.status, 200);
  await closed.json();
  assert.equal(app.browsers.state("native-auth").status, "closed");
});
