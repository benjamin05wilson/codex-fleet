import { fleetFetch } from "./helpers/http.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Store, id } from "../server/store.mjs";
import { Engine, scopesOverlap } from "../server/engine.mjs";
import { Brain } from "../server/brain.mjs";
import { Workflows } from "../server/workflows.mjs";
import { Terminals } from "../server/terminals.mjs";
import { git, repository } from "../server/git.mjs";
import { createApp } from "../server/app.mjs";
import { searchWorkspace, previewFile } from "../server/search.mjs";
import { stopProcessTree } from "../shared/platform.mjs";
const bin = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
const exitOnceBin = fileURLToPath(
  new URL("./fixtures/codex-exit-once.mjs", import.meta.url),
);
await chmod(bin, 0o700);
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out");
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-focused-")),
    source = join(root, "source"),
    data = join(root, "data");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await writeFile(join(source, "README.md"), "# Fixture\n");
  await git(source, ["add", "-A"]);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Initial",
  ]);
  const store = new Store(join(data, "test.sqlite"));
  const project = store.put("project", {
    id: id(),
    name: "Fixture",
    ...(await repository(source)),
    validation: 'node -e "process.exit(0)"',
  });
  const brain = new Brain(store, data);
  await brain.refresh(project);
  const engines = [];
  const createEngine = () => {
    const engine = new Engine(store, brain, data, { bin, concurrency: 3 });
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    await Promise.all(engines.map((engine) => engine.shutdown()));
    await brain.close();
    for (const engine of engines) {
      assert.equal(engine.workers.size, 0);
      assert.equal(engine.finishes.size, 0);
      assert.equal(engine.scans.size, 0);
    }
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, data, store, project, brain, createEngine };
}
test("scope claims match path segments, and empty scope means the repository", () => {
  assert.equal(scopesOverlap(["src/api"], ["src/api/tests"]), true);
  assert.equal(scopesOverlap(["src/api"], ["src/apis"]), false);
  assert.equal(scopesOverlap([], ["src"]), true);
});
test("migration backs up the legacy database and retains objects and events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-migration-")),
    path = join(root, "fleet.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new Store(path);
  legacy.put("project", { id: "project", name: "Preserved" });
  legacy.event("project", null, "preserved");
  legacy.db.exec("PRAGMA user_version=0");
  legacy.close();
  const upgraded = new Store(path);
  assert.equal(upgraded.get("project", "project").name, "Preserved");
  assert.equal(upgraded.events()[0].type, "preserved");
  assert.ok((await readdir(root)).some((f) => f.includes("pre-v1")));
  assert.equal(
    upgraded.db.prepare("PRAGMA user_version").get().user_version,
    1,
  );
  upgraded.close();
});
test("legacy active execution blocks migration without silently interrupting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-migration-active-")),
    path = join(root, "fleet.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new Store(path);
  legacy.put("run", { id: "active", status: "running" });
  legacy.db.exec("PRAGMA user_version=0");
  legacy.close();
  assert.throws(() => new Store(path), /Finish or explicitly stop/);
});
test("event pagination replays every event in order beyond the first page", async (t) => {
  const w = await setup(t);
  for (let i = 0; i < 1100; i++)
    w.store.event(w.project.id, "long", "message", { index: i });
  let cursor = 0,
    events = [];
  while (true) {
    const batch = w.store.replay(cursor);
    if (!batch.length) break;
    events.push(...batch);
    cursor = batch.at(-1).seq;
  }
  assert.equal(new Set(events.map((e) => e.seq)).size, events.length);
  assert.equal(events.filter((e) => e.runId === "long").length, 1100);
  const recent = w.store.events({ runId: "long", limit: 600 });
  const older = w.store.events({
    runId: "long",
    before: recent[0].seq,
    limit: 600,
  });
  assert.equal(recent.length + older.length, 1100);
});
test("search returns project notes and committed file previews, excluding secret files", async (t) => {
  const w = await setup(t);
  await w.brain.write(
    w.project,
    "Pagination.md",
    "# Pagination\nA cursor design.",
  );
  const results = await searchWorkspace(
    w.store,
    w.brain,
    "pagination",
    w.project.id,
  );
  assert.ok(results.some((r) => r.kind === "note"));
  assert.match(
    (await previewFile(w.project, "README.md")).content,
    /# Fixture/,
  );
  await assert.rejects(previewFile(w.project, "../outside"), /excluded/);
  await assert.rejects(previewFile(w.project, ".env"), /excluded/);
});
test("unavailable sandbox is recorded without an unsandboxed fallback", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const run = engine.create(w.project.id, {
    title: "Check failure",
    prompt: "TEST_EDIT",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  engine.bin = "/definitely-missing-fleet-codex";
  await engine.validate(run.id);
  await until(
    () => w.store.get("run", run.id).validation?.status === "unavailable",
  );
  assert.equal(w.store.get("run", run.id).validation.sandboxed, true);
  assert.ok(
    !w.store
      .events({ runId: run.id })
      .some((e) => e.type === "validation.unsandboxed.approved"),
  );
});
test("worker survives daemon detach; reconnect does not duplicate a turn or usage", async (t) => {
  const w = await setup(t),
    first = w.createEngine();
  const run = first.create(w.project.id, {
    title: "Recover",
    prompt: "TEST_DELAY TEST_EDIT",
    sandbox: "workspace-write",
  });
  first.queue(run.id);
  await until(() => w.store.get("run", run.id).threadId);
  const identity = w.store.get("run", run.id).worker.identity;
  first.shutdown({ preserveWorkers: true });
  const second = w.createEngine();
  await until(() => w.store.get("run", run.id).status === "review");
  const result = w.store.get("run", run.id);
  assert.equal(result.attempt, 1);
  assert.equal(result.worker.identity, identity);
  assert.equal(result.usage.input_tokens, 20);
  assert.equal(
    w.store.events({ runId: run.id }).filter((e) => e.type === "turn.completed")
      .length,
    1,
  );
});
test("successful follow-ups reuse the durable Codex and browser connection", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  let browserConnections = 0;
  engine.browsers = {
    connection: () => {
      browserConnections++;
      return {
        node: process.execPath,
        script: "fixture-browser.mjs",
        url: "http://127.0.0.1:1/api/browser-agent",
        token: "fixture-browser-token",
      };
    },
  };
  const run = engine.create(w.project.id, {
    title: "Reuse connection",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  const first = w.store.get("run", run.id),
    identity = first.worker.identity;
  assert.equal(engine.processes.get(run.id).idle, true);

  engine.queue(run.id, "TEST_EDIT again");
  await until(
    () =>
      w.store.get("run", run.id).status === "review" &&
      w.store.get("run", run.id).attempt === 2,
  );
  const result = w.store.get("run", run.id),
    events = w.store.events({ runId: run.id });
  assert.equal(result.worker.identity, identity);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "worker.phase" &&
        event.data.phase === "Connecting to Codex",
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "worker.phase" &&
        event.data.phase === "Connecting project browser",
    ).length,
    1,
  );
  assert.equal(browserConnections, 1);
  assert.equal(
    events.filter((event) => event.type === "thread.started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "worker.resumed").length,
    1,
  );
  assert.equal(result.usage.input_tokens, 40);
  assert.equal(result.usage.output_tokens, 20);
});
test("an old idle chat gains brain tools on its next turn, then retains them across follow-ups", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const run = engine.create(w.project.id, {
    title: "Brain upgrade",
    prompt: "TEST_POLICY",
    sandbox: "workspace-write",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  const oldIdentity = w.store.get("run", run.id).worker.identity;
  let connections = 0;
  engine.brainTools = {
    connection: () => {
      connections++;
      return {
        node: process.execPath,
        script: fileURLToPath(
          new URL("../server/brain-mcp.mjs", import.meta.url),
        ),
        url: "http://127.0.0.1:1/fixture",
        token: "fixture-only",
      };
    },
  };
  engine.queue(run.id, "TEST_POLICY second turn");
  await until(
    () =>
      w.store.get("run", run.id).status === "review" &&
      w.store.get("run", run.id).attempt === 2,
  );
  const next = w.store.get("run", run.id);
  assert.notEqual(next.worker.identity, oldIdentity);
  assert.equal(next.worker.brainTools, true);
  const policy = JSON.parse(
    await readFile(join(next.worktree, "policy.json"), "utf8"),
  );
  assert.ok(policy.thread.config["mcp_servers.fleet_brain"]);
  assert.match(policy.thread.developerInstructions, /use fleet_brain search/);
  engine.queue(run.id, "TEST_POLICY third turn");
  await until(
    () =>
      w.store.get("run", run.id).status === "review" &&
      w.store.get("run", run.id).attempt === 3,
  );
  assert.equal(
    w.store.get("run", run.id).worker.identity,
    next.worker.identity,
  );
  assert.equal(connections, 1);
});
test("worker retries one pre-initialization app-server exit without replaying a turn", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  engine.bin = exitOnceBin;
  const run = engine.create(w.project.id, {
    title: "Startup retry",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  const result = w.store.get("run", run.id),
    events = w.store.events({ runId: run.id });
  assert.equal(result.attempt, 1);
  assert.equal(
    events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "worker.diagnostic" &&
        /retrying once/.test(event.data.text),
    ),
  );
});
test("unreadable saved Codex thread is replaced before starting the turn", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const run = engine.create(w.project.id, {
    title: "Thread replacement",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  w.store.patch("run", run.id, {
    threadId: "fixture-exit-on-resume",
    summary: "Prior context remains available.",
  });
  engine.queue(run.id, "TEST_EDIT replacement turn");
  await until(() => w.store.get("run", run.id).status === "review");
  const result = w.store.get("run", run.id),
    events = w.store.events({ runId: run.id });
  assert.equal(result.attempt, 1);
  assert.equal(result.threadId, "fixture-thread");
  assert.equal(
    events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "worker.diagnostic" &&
        /starting a replacement/.test(event.data.text),
    ),
  );
  await delay(1000);
  assert.equal(w.store.get("run", run.id).status, "review");
  assert.equal(w.store.get("run", run.id).worker.persistent, true);
  assert.equal(engine.processes.get(run.id).idle, true);
});
test("worker crash becomes interrupted and never automatically retries", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const run = engine.create(w.project.id, {
    title: "Crash",
    prompt: "TEST_HANG",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).threadId);
  const current = w.store.get("run", run.id),
    worker = engine.processes.get(run.id),
    status = JSON.parse(
      await readFile(join(current.worker.directory, "status.json"), "utf8"),
    );
  // Some test runners set both color variables. Permit only Node's known
  // startup warning; unexpected worker diagnostics must still fail this check.
  assert.match(
    await readFile(join(current.worker.directory, "worker.log"), "utf8"),
    /^(?:\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/,
  );
  await writeFile(
    join(current.worker.directory, "worker.log"),
    `Native crash context sk-proj-${"x".repeat(32)}`,
  );
  if (process.platform === "win32") stopProcessTree({ pid: status.pid });
  else process.kill(-status.pid, "SIGKILL");
  await until(() => w.store.get("run", run.id).status === "interrupted", 16000);
  const interrupted = w.store.get("run", run.id);
  assert.equal(interrupted.attempt, 1);
  assert.match(interrupted.error, /Worker diagnostics:\nNative crash context/);
  assert.doesNotMatch(interrupted.error, /sk-proj-/);
  // Status is committed before the receipt finishes. Keep tracking the worker
  // until its receipt and poller settle, as production shutdown must do too.
  await until(() => !engine.workers.has(worker), 5000);
  assert.equal(worker.disposed, true);
  assert.equal(engine.processes.size, 0);
});
test("worker survives a transient heartbeat publication lock", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const run = engine.create(w.project.id, {
    title: "Heartbeat lock",
    prompt: "TEST_HANG",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).threadId);
  const directory = w.store.get("run", run.id).worker.directory;
  await rename(join(directory, "status.json"), join(directory, "status.saved"));
  await mkdir(join(directory, "status.json"));
  await until(async () =>
    (await readFile(join(directory, "events.jsonl"), "utf8")).includes(
      "Could not publish worker heartbeat",
    ),
  );
  assert.equal(w.store.get("run", run.id).status, "running");
  await rm(join(directory, "status.json"), { recursive: true, force: true });
  await until(async () => {
    try {
      return JSON.parse(await readFile(join(directory, "status.json"), "utf8"))
        .time;
    } catch {
      return false;
    }
  });
  engine.stop(run.id);
  await until(() => w.store.get("run", run.id).status === "paused");
});
test("overlapping writers queue while independent scopes can run", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const a = engine.create(w.project.id, {
    title: "API",
    prompt: "TEST_HANG",
    sandbox: "workspace-write",
    scopes: ["src/api"],
  });
  const b = engine.create(w.project.id, {
    title: "API tests",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
    scopes: ["src/api/tests"],
  });
  engine.queue(a.id);
  await until(() => w.store.get("run", a.id).threadId);
  engine.queue(b.id);
  await until(() => w.store.get("run", b.id).blockedReason);
  assert.equal(w.store.get("run", b.id).status, "queued");
  engine.stop(a.id);
  await until(() => w.store.get("run", b.id).status === "review");
});
test("context is project-isolated, ranked, bounded, and excludes unapproved proposals", async (t) => {
  const w = await setup(t);
  await w.brain.write(
    w.project,
    "Pagination.md",
    "# Pagination\nUse cursor pagination for the notes API.",
  );
  await w.brain.write(
    w.project,
    "Unsafe proposal.md",
    "---\nkind: proposal\nverification: proposed\n---\n# Pagination\nUnapproved memory",
  );
  const context = await w.brain.selectContext(
    w.project,
    "pagination notes API",
    { excluded: ["Decisions.md"], budget: 1000 },
  );
  assert.equal(context.notes[0].filename, "Pagination.md");
  assert.ok(context.text.length <= 1000);
  assert.ok(!context.text.includes("Unapproved memory"));
  assert.ok(context.omitted.some((n) => n.reason === "unapproved proposal"));
});
test("fixed file findings resolve and reappear when the defect returns", async (t) => {
  const w = await setup(t),
    engine = w.createEngine();
  const run = engine.create(w.project.id, {
    title: "Security",
    prompt: "TEST_SECRET",
    sandbox: "workspace-write",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  const path = join(w.store.get("run", run.id).worktree, "unsafe.js");
  await writeFile(path, "export const safe = true;\n");
  await engine.scan(run.id);
  assert.equal(
    w.store.list("finding").find((f) => f.rule === "secret").state,
    "resolved",
  );
  await writeFile(path, 'const token="sk-proj-' + "x".repeat(32) + '";\n');
  await engine.scan(run.id);
  assert.equal(
    w.store.list("finding").find((f) => f.rule === "secret").state,
    "suspected",
  );
});
test("approved workflow executes once, validates dependencies, and proposes completion without accepting", async (t) => {
  const w = await setup(t),
    engine = w.createEngine(),
    workflows = new Workflows(w.store, engine);
  t.after(() => workflows.close());
  const plan = workflows.create(w.project.id, {
    title: "Notes",
    objective: "TEST_EDIT",
    templateId: "implement",
    tasks: [
      { title: "First", prompt: "TEST_EDIT", scopes: [], dependencies: [] },
      {
        title: "Second",
        prompt: "Inspect the inherited result",
        scopes: [],
        dependencies: [0],
      },
    ],
  });
  assert.equal(w.store.list("run").length, 0);
  const approved = workflows.approve(plan.id);
  workflows.approve(plan.id);
  assert.equal(w.store.list("run").length, 2);
  await until(() => w.store.get("workflow", plan.id).status === "needs-review");
  assert.ok(
    w.store
      .list("run")
      .every((r) => r.status === "review" && r.validation.status === "passed"),
  );
  assert.match(
    await readFile(
      join(w.store.get("run", approved.runIds[1]).worktree, "artifact.txt"),
      "utf8",
    ),
    /deterministic/,
  );
  assert.equal(
    (await git(w.source, ["rev-parse", "HEAD"])).trim(),
    w.project.head,
  );
});
test("workflow rejects cycles, oversized plans and missing acceptance checks", async (t) => {
  const w = await setup(t),
    engine = w.createEngine(),
    workflows = new Workflows(w.store, engine);
  t.after(() => workflows.close());
  assert.throws(
    () =>
      workflows.create(w.project.id, {
        title: "Bad",
        objective: "Bad",
        tasks: [{ title: "Task", prompt: "Task", dependencies: [0] }],
      }),
    /earlier tasks/,
  );
  assert.throws(
    () =>
      workflows.create(w.project.id, {
        title: "Bad",
        objective: "Bad",
        tasks: Array(6).fill({ title: "Task", prompt: "Task" }),
      }),
    /five tasks/,
  );
  w.store.patch("project", w.project.id, { validation: "" });
  const plan = workflows.create(w.project.id, {
    title: "No check",
    objective: "Task",
  });
  assert.throws(() => workflows.approve(plan.id), /validation command/);
  assert.equal(w.store.list("run").length, 0);
});
test("API duplicate identities replay a result and reject changed payloads", async (t) => {
  const w = await setup(t);
  // Close the HTTP app's database before setup's outer cleanup removes its
  // parent directory; Windows does not allow unlinking an open SQLite file.
  await t.test("requests replay without duplicate mutations", async (t) => {
    const app = await createApp({
      dataDir: join(w.root, "http"),
      staticDir: join(w.root, "static"),
      bin,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await app.close();
      app.store.close();
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const state = await fleetFetch(base + "/api/state").then((r) => r.json());
    const headers = {
      "Content-Type": "application/json",
      "X-Fleet-Token": state.csrf,
      "Idempotency-Key": "stable-test-request",
    };
    const send = (path) =>
      fetch(base + "/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ path }),
      });
    const first = await send(w.source),
      second = await send(w.source);
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), await second.json());
    assert.equal((await send("/another/path")).status, 409);
  });
});
test("interactive terminal requires a single owner and invalidates checks", async (t) => {
  const w = await setup(t),
    engine = w.createEngine(),
    terminals = new Terminals(engine);
  engine.terminals = terminals;
  t.after(() => terminals.close());
  const run = engine.create(w.project.id, {
    title: "Shell",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  engine.queue(run.id);
  await until(() => w.store.get("run", run.id).status === "review");
  const shell = await terminals.open(w.store.get("run", run.id), "desktop");
  assert.equal(w.store.get("run", run.id).validation, null);
  assert.throws(() => engine.queue(run.id, "More"), /Close the worktree shell/);
  await assert.rejects(
    terminals.open(w.store.get("run", run.id), "cli"),
    /another client/,
  );
  assert.throws(
    () => terminals.control(run.id, "wrong", "input", { data: "exit\r" }),
    /does not own/,
  );
  terminals.control(run.id, shell.lease, "input", {
    data: "printf FLEET_TERMINAL_TEST\r",
  });
  await until(() =>
    terminals
      .get(run.id)
      .events.some((e) => e.data.includes("FLEET_TERMINAL_TEST")),
  );
  terminals.control(run.id, shell.lease, "close", {});
});
