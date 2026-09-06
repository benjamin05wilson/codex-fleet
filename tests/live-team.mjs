// Explicit integration test: up to six real model turns in an isolated repository.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { git } from "../server/git.mjs";
if (!process.argv.includes("--run"))
  throw new Error("Pass --run to authorize up to six real model turns.");
const root = await mkdtemp(join(tmpdir(), "fleet-live-team-")),
  source = join(root, "source");
await mkdir(source);
await git(source, ["init", "-b", "main"]);
const original = "export const add = (a, b) => a - b;\n";
await writeFile(join(source, "calc.mjs"), original);
await writeFile(
  join(source, "calc.test.mjs"),
  "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './calc.mjs'; test('adds numbers', () => assert.equal(add(2, 3), 5));\n",
);
await git(source, ["add", "-A"]);
await git(source, [
  "-c",
  "user.name=Fleet verification",
  "-c",
  "user.email=verification@localhost",
  "commit",
  "-m",
  "Isolated team verification",
]);
const app = await createApp({ dataDir: join(root, "data"), concurrency: 3 });
async function until(fn) {
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(250);
  }
  throw new Error("Live team verification timed out");
}
try {
  const project = await app.addProject({
    path: source,
    validation: "node --test",
  });
  const team = await app.teams.enable(project.id, {
    approved: true,
    maxRounds: 2,
    timeoutMinutes: 3,
  });
  console.log(
    JSON.stringify({
      stage: "initial-team-started",
      root,
      members: team.members,
    }),
  );
  const initial = await until(() =>
    app.store
      .list("team-round")
      .find((r) => r.kind === "initial" && r.status !== "running"),
  );
  assert.equal(initial.status, "completed", JSON.stringify(initial));
  const threads = Object.fromEntries(
    Object.entries(team.members).map(([role, key]) => [
      role,
      app.store.get("run", key).threadId,
    ]),
  );
  assert.equal(new Set(Object.values(threads)).size, 3);
  console.log(
    JSON.stringify({
      stage: "initial-team-completed",
      roles: Object.keys(initial.reports),
      distinctThreads: 3,
    }),
  );
  const lead = await app.teams.task(project.id, {
    title: "Fix addition",
    prompt:
      "Fix add(a,b) in calc.mjs to add instead of subtract. Keep the existing test unchanged. Run node --test and report the result. Do not commit, publish, install dependencies or use network services.",
    sandbox: "workspace-write",
    scopes: ["calc.mjs"],
  });
  const round = await until(() =>
    app.store
      .list("team-round")
      .find((r) => r.kind === "changes" && r.status !== "running"),
  );
  assert.equal(round.status, "completed", JSON.stringify(round));
  for (const [role, key] of Object.entries(team.members))
    assert.equal(app.store.get("run", key).threadId, threads[role]);
  await app.engine.validate(lead.id);
  await until(
    () => app.store.get("run", lead.id).validation?.status !== "running",
  );
  assert.equal(app.store.get("run", lead.id).validation.status, "passed");
  assert.equal(await readFile(join(source, "calc.mjs"), "utf8"), original);
  const result = {
    result: "PASS",
    realModelTurns: 6,
    distinctThreads: 3,
    resumedAllThreads: true,
    snapshot: round.snapshot,
    reports: round.reports,
    sourceUnchanged: true,
    validation: "passed",
    accepted: false,
    root,
  };
  await writeFile(
    join(root, "verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await app.close();
  await until(() => !app.engine.processes.size && !app.engine.busy);
  app.store.close();
}
