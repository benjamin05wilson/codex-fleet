// Explicit opt-in integration: one real Codex model turn, isolated temporary repo.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { git } from "../server/git.mjs";
if (!process.argv.includes("--run"))
  throw new Error("Pass --run to authorize one live model turn.");
const root = await mkdtemp(join(tmpdir(), "fleet-live-session-"));
const source = join(root, "source");
await mkdir(source);
await git(source, ["init", "-b", "main"]);
const original = "export const add = (a, b) => a - b;\n";
await writeFile(join(source, "calc.mjs"), original);
await writeFile(
  join(source, "calc.test.mjs"),
  "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './calc.mjs'; test('adds', () => assert.equal(add(2, 3), 5));\n",
);
await git(source, ["add", "-A"]);
await git(source, [
  "-c",
  "user.name=Fleet verification",
  "-c",
  "user.email=verification@localhost",
  "commit",
  "-m",
  "Isolated verification input",
]);
const app = await createApp({ dataDir: join(root, "data"), concurrency: 1 });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const { csrf } = await fetch(base + "/api/state").then((r) => r.json());
async function post(path, input = {}) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fleet-token": csrf },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
let run;
try {
  const project = await post("/api/projects", {
    path: source,
    validation: "node --test",
  });
  run = await post(`/api/projects/${project.id}/runs`, {
    title: "Live wiring verification",
    prompt:
      "Fix add(a,b) in calc.mjs so it adds instead of subtracts. Keep the existing test unchanged, run node --test, and report the result. Do not commit, push, install dependencies, or access network services.",
    sandbox: "workspace-write",
    scopes: ["calc.mjs"],
  });
  await post(`/api/runs/${run.id}/start`);
  console.log(
    JSON.stringify({ stage: "real-model-started", root, runId: run.id }),
  );
  const deadline = Date.now() + 180_000;
  while (
    ["queued", "running", "preparing"].includes(
      app.store.get("run", run.id).status,
    )
  ) {
    if (Date.now() > deadline)
      throw new Error("Live model verification timed out.");
    await delay(500);
  }
  run = app.store.get("run", run.id);
  assert.equal(run.status, "review", run.error || run.summary);
  await post(`/api/runs/${run.id}/validate`);
  const checkDeadline = Date.now() + 150_000;
  while (app.store.get("run", run.id).validation?.status === "running") {
    if (Date.now() > checkDeadline)
      throw new Error("Sandbox validation timed out.");
    await delay(250);
  }
  run = app.store.get("run", run.id);
  assert.equal(run.validation.status, "passed", JSON.stringify(run.validation));
  assert.equal(await readFile(join(source, "calc.mjs"), "utf8"), original);
  assert.ok(run.usage.output_tokens > 0);
  console.log(
    JSON.stringify({
      result: "PASS",
      realModelCalls: 1,
      validation: run.validation.status,
      changedFiles: run.files,
      sourceUnchanged: true,
      accepted: false,
      root,
      usage: run.usage,
    }),
  );
} finally {
  await app.close();
  app.store.close();
}
