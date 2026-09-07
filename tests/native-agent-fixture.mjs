import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.mjs";

export async function createNativeAgentFixture() {
  const directory = await mkdtemp(join(tmpdir(), "fleet-native-agent-test-"));
  const app = await createApp({
    dataDir: directory,
    staticDir: fileURLToPath(new URL("../dist", import.meta.url)),
    // Never depend on a developer/runner's Codex install or personal login.
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
  });
  app.store.put("preferences", {
    id: "onboarding",
    version: 1,
    sandbox: "workspace-write",
    completedAt: new Date().toISOString(),
  });
  app.store.put("project", {
    id: "trial",
    name: "Native test",
    path: directory,
  });
  const run = {
    id: "trial-agent",
    projectId: "trial",
    status: "running",
    worker: { identity: "fixture-only" },
    title: "Native browser layout test",
    prompt: "Open the test page",
    files: [],
    scopes: [],
    dependencies: [],
    usage: {},
  };
  app.store.put("run", run);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const connection = app.browsers.connection(run, "fixture-only");
  return {
    env: {
      FLEET_SHARED_TEST_ORIGIN: "http://127.0.0.1:" + app.server.address().port,
      FLEET_SHARED_TEST_CAPABILITY: connection.token,
    },
    async close() {
      await app.close();
      app.store.close();
      console.log("Retained isolated native agent fixture: " + directory);
    },
  };
}
