import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { NativeOnlyBrowsers } from "../server/native-only-browsers.mjs";
import { browserInstructions } from "../shared/browser-tools.mjs";

test("the product daemon never provides a streamed browser or agent connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-native-only-test-"));
  const app = await createApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.ok(app.browsers instanceof NativeOnlyBrowsers);
  assert.equal(app.engine.browsers.connection({ id: "run" }, {}), null);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const state = await (await fetch(origin + "/api/state")).json();
  assert.equal(state.browserMode, "native");
  assert.equal(state.browserAvailable, false);
  assert.equal(state.browserAgentAvailable, false);
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
    assert.match((await result.json()).error, /native desktop browser only/);
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
  assert.equal(agent.status, 410);
  await agent.json();
  const read = await (
    await fetch(origin + "/api/projects/project/browser", { headers })
  ).json();
  assert.equal(read.mode, "native");
  assert.equal(read.available, false);
  assert.match(
    browserInstructions(false),
    /no shared-browser option or fallback/,
  );
  assert.doesNotMatch(
    browserInstructions(false),
    /Let this chat browse|Share browser/,
  );
});
