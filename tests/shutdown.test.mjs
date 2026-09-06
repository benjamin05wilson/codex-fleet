import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.mjs";
import { quickSession } from "../server/workspace.mjs";
import { createWorktree } from "../server/git.mjs";

test("daemon shutdown settles in-flight scans before database disposal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-shutdown-test-"));
  const app = await createApp({
    dataDir: root,
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
  });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = await quickSession(app, { approved: true, sandbox: "read-only" });
  const project = app.store.get("project", run.projectId);
  app.store.patch("run", run.id, await createWorktree(project, run, root));
  const pending = app.engine.scan(run.id);
  assert.ok(app.engine.scans.has(pending));
  await app.close();
  assert.equal(app.engine.scans.size, 0);
  await assert.doesNotReject(pending);
});
