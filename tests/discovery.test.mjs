import { fleetFetch } from "./helpers/http.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRepository, discoverCodex } from "../server/discovery.mjs";
import { git } from "../server/git.mjs";
import { createApp } from "../server/app.mjs";
import { connect } from "node:net";
const bin = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
test("daemon shutdown closes clients with unfinished HTTP headers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-shutdown-"));
  const app = await createApp({ dataDir: root, bin });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const socket = connect(app.server.address().port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise((r) => socket.once("connect", r));
  socket.write("GET /api/state HTTP/1.1\r\n");
  t.after(async () => {
    socket.destroy();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 2000);
});
test("model discovery follows pages and exposes only safe account metadata", async () => {
  const result = await discoverCodex(bin, process.cwd());
  assert.deepEqual(
    result.models.map((m) => m.model),
    ["fixture-first", "fixture-second"],
  );
  assert.equal(result.accountType, "apiKey");
  assert.equal(JSON.stringify(result).includes("must-not-be-exposed"), false);
});
test("repository inspection reads actual Git and scripts without executing them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-inspection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "exit 99" } }),
  );
  await git(root, ["add", "package.json"]);
  await git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Test repository",
  ]);
  const result = await inspectRepository(root);
  assert.equal(result.branch, "main");
  assert.equal(result.dirty, false);
  assert.equal(result.commands[0].command, "pnpm test");
  await assert.rejects(inspectRepository("relative/path"), /absolute/);
});
test("API reports actual concurrency and no longer creates example projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-discovery-api-"));
  const app = await createApp({ dataDir: root, bin, concurrency: 1 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await fleetFetch(base + "/api/state").then((r) => r.json());
  const capabilities = await fleetFetch(base + "/api/capabilities").then((r) =>
    r.json(),
  );
  assert.equal(state.limits.concurrency, 1);
  assert.equal(capabilities.limits.concurrency, 1);
  assert.ok(state.workflowTemplates[0].tasks[0].prompt);
  const response = await fetch(base + "/api/example", {
    method: "POST",
    headers: { "x-fleet-token": state.csrf },
    body: "{}",
  });
  assert.equal(response.status, 404);
  assert.equal(app.store.list("project").length, 0);
});
