import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Store, id } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { attachWorker, resumeWorker } from "../server/durable.mjs";
import { createApp } from "../server/app.mjs";
import { quickSession } from "../server/workspace.mjs";
import { git } from "../server/git.mjs";

const bin = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
const deferred = () => Promise.withResolvers();
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for worker lifecycle");
}
const journal = (events) =>
  events
    .map((event, i) => JSON.stringify({ seq: i + 1, event }) + "\n")
    .join("");
const completed = {
  type: "turn.completed",
  usage: { input_tokens: 20, output_tokens: 10 },
};

test("worktree watchers resolve aliases to native paths and still observe edits", async (t) => {
  const { root, engine, store, run } = await fixture(t);
  const directory = join(root, "long worktree directory");
  await mkdir(directory);
  let alias = join(root, "worktree-alias");
  await symlink(
    directory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  if (process.platform === "win32") {
    // Preserve the runner's short temp-root spelling and exercise forward
    // separators too. Junctions require no elevated symlink privilege.
    alias = alias.replaceAll("\\", "/");
  }
  const canonical = realpathSync.native(directory);
  assert.equal(realpathSync.native(alias), canonical);
  const resolvePath = t.mock.method(realpathSync, "native");
  const scan = t.mock.method(engine, "scan");
  const watched = store.patch("run", run.id, { worktree: alias });
  engine.watchWorktree(watched);
  assert.equal(engine.watchers.has(run.id), true);
  assert.equal(resolvePath.mock.calls[0].arguments[0], alias);
  assert.equal(resolvePath.mock.calls[0].result, canonical);
  await writeFile(join(directory, "observed.txt"), "changed");
  await until(() => scan.mock.callCount() > 0);
  assert.equal(scan.mock.calls[0].arguments[0], run.id);
  await engine.shutdown();
  assert.equal(engine.watchers.size, 0);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-worker-lifecycle-"));
  const store = new Store(join(root, "test.sqlite"));
  const project = store.put("project", { id: id(), name: "Lifecycle fixture" });
  const engines = [];
  const createEngine = () => {
    const engine = new Engine(store, { receipt: async () => {} }, root, {
      bin,
    });
    // Journal regressions need no repository or actual model process.
    engine.scan = async () => ({ files: [], diff: "" });
    engines.push(engine);
    return engine;
  };
  const engine = createEngine();
  const run = engine.create(project.id, {
    title: "Journal fixture",
    prompt: "fixture",
    sandbox: "read-only",
  });
  const worker = {
    directory: join(root, "worker"),
    identity: id(),
    createdAt: Date.now(),
    persistent: true,
    cursor: 0,
    turnCursor: 0,
  };
  await mkdir(worker.directory);
  await writeFile(
    join(worker.directory, "status.json"),
    JSON.stringify({
      identity: worker.identity,
      time: Date.now(),
      idle: true,
    }),
  );
  store.patch("run", run.id, { status: "running", attempt: 1, worker });
  t.after(async () => {
    for (const runtime of engines) {
      // These synthetic workers have no OS process to acknowledge a stop.
      for (const state of runtime.workers) state.dispose();
      await runtime.shutdown();
    }
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, engine, createEngine, run, worker };
}

test("idle heartbeat waits for the successful journal completion and handoff", async (t) => {
  const { store, engine, run, worker } = await fixture(t);
  const events = [{ type: "turn.started" }];
  await writeFile(join(worker.directory, "events.jsonl"), journal(events));
  const state = attachWorker(engine, store.get("run", run.id));
  await state.poll();
  assert.equal(store.get("run", run.id).status, "running");
  assert.equal(
    store.events({ runId: run.id }).some((e) => e.type === "run.failed"),
    false,
  );
  events.push(
    {
      type: "item.completed",
      item: { type: "agent_message", text: "New handoff" },
    },
    completed,
  );
  await writeFile(join(worker.directory, "events.jsonl"), journal(events));
  await state.poll();
  assert.equal(store.get("run", run.id).status, "review");
  assert.equal(store.get("run", run.id).summary, "New handoff");
  assert.equal(store.get("run", run.id).usage.input_tokens, 20);
  await state.poll();
  assert.equal(
    store.events({ runId: run.id }).filter((e) => e.type === "run.review")
      .length,
    1,
  );
});

test("reconnect with a pending follow-up ignores previous idle and completion", async (t) => {
  const { store, engine, createEngine, run, worker } = await fixture(t);
  const events = [{ type: "turn.started" }, completed, { type: "worker.idle" }];
  await writeFile(join(worker.directory, "events.jsonl"), journal(events));
  const first = attachWorker(engine, store.get("run", run.id));
  await first.poll();
  assert.equal(store.get("run", run.id).status, "review");
  assert.equal(
    await resumeWorker(engine, store.get("run", run.id), "Follow-up"),
    true,
  );
  assert.equal(store.get("run", run.id).worker.pendingAttempt, 2);
  await engine.shutdown({ preserveWorkers: true });
  const second = createEngine();
  const state = second.processes.get(run.id);
  await state.poll();
  await state.poll();
  assert.equal(store.get("run", run.id).status, "running");
  assert.equal(store.get("run", run.id).usage.input_tokens, 20);
  assert.equal(state.awaitingResume, true);
  assert.equal(
    JSON.parse(await readFile(join(worker.directory, "command.json"), "utf8"))
      .attempt,
    2,
  );

  // Starting the new turn does not make the previous heartbeat authoritative.
  events.push({ type: "worker.resumed", attempt: 2 }, { type: "turn.started" });
  await writeFile(join(worker.directory, "events.jsonl"), journal(events));
  await state.poll();
  assert.equal(store.get("run", run.id).status, "running");
  assert.equal(store.get("run", run.id).worker.pendingAttempt, null);
  events.push(completed, { type: "worker.idle" });
  await writeFile(join(worker.directory, "events.jsonl"), journal(events));
  await state.poll();
  const result = store.get("run", run.id);
  assert.equal(result.status, "review");
  assert.equal(result.attempt, 2);
  assert.equal(result.usage.input_tokens, 40);
  assert.equal(
    store.events({ runId: run.id }).filter((e) => e.type === "run.review")
      .length,
    2,
  );
});

test("shutdown waits for idle release acknowledgement and disposes the poller", async (t) => {
  const { store, engine, run, worker } = await fixture(t);
  store.patch("run", run.id, { status: "review" });
  const state = attachWorker(engine, store.get("run", run.id));
  await state.poll();
  let closed = false;
  const shutdown = engine.shutdown().then(() => {
    closed = true;
  });
  await until(() =>
    readFile(join(worker.directory, "stop"), "utf8").catch(() => false),
  );
  await state.poll();
  assert.equal(closed, false);
  assert.equal(state.releasing, true);
  await writeFile(
    join(worker.directory, "events.jsonl"),
    journal([{ type: "worker.exit", exitCode: 0 }]),
  );
  await state.poll();
  await shutdown;
  assert.equal(state.disposed, true);
  assert.equal(state.pending, null);
  assert.equal(engine.processes.size, 0);
  assert.equal(engine.workers.size, 0);
  assert.equal(store.get("run", run.id).status, "review");
  const reads = t.mock.method(store, "get");
  await delay(300);
  await state.poll();
  assert.equal(reads.mock.callCount(), 0);
});

test("detach during final scan commits duration and completion only once after reconnect", async (t) => {
  const { store, engine, createEngine, run, worker } = await fixture(t);
  const started = Date.now();
  let time = started + 10000;
  t.mock.method(Date, "now", () => time);
  store.patch("run", run.id, {
    startedAt: new Date(started).toISOString(),
    durationMs: 4000,
    finishedAt: null,
  });
  await writeFile(
    join(worker.directory, "status.json"),
    JSON.stringify({ identity: worker.identity, time, idle: true }),
  );
  const entered = deferred(),
    release = deferred();
  engine.scan = async () => {
    entered.resolve();
    await release.promise;
  };
  t.after(() => release.resolve());
  await writeFile(
    join(worker.directory, "events.jsonl"),
    journal([{ type: "turn.started" }, completed, { type: "worker.idle" }]),
  );
  const state = attachWorker(engine, store.get("run", run.id));
  await entered.promise;
  let closed = false;
  const pending = engine.shutdown({ preserveWorkers: true }).then(() => {
    closed = true;
  });
  await delay(30);
  assert.equal(closed, false);
  release.resolve();
  await pending;
  assert.equal(state.disposed, true);
  assert.equal(engine.finishes.size, 0);
  assert.equal(store.get("run", run.id).durationMs, 4000);
  assert.equal(store.get("run", run.id).finishedAt, null);
  time += 1;
  const second = createEngine();
  await second.processes.get(run.id).poll();
  assert.equal(store.get("run", run.id).status, "review");
  assert.equal(store.get("run", run.id).durationMs, 14001);
  assert.ok(store.get("run", run.id).finishedAt);
  await second.processes.get(run.id).poll();
  assert.equal(store.get("run", run.id).durationMs, 14001);
  assert.equal(store.get("run", run.id).usage.input_tokens, 20);
  assert.equal(
    store.events({ runId: run.id }).filter((e) => e.type === "turn.completed")
      .length,
    1,
  );
});

test("retired reviewer events and exit cannot mutate or remove its replacement", async (t) => {
  const { root, store, engine, run, worker } = await fixture(t);
  store.patch("run", run.id, { status: "review" });
  const previous = attachWorker(engine, store.get("run", run.id));
  await previous.poll();
  const replacement = {
    ...worker,
    directory: join(root, "replacement"),
    identity: id(),
  };
  await mkdir(replacement.directory);
  await writeFile(
    join(replacement.directory, "status.json"),
    JSON.stringify({ time: Date.now(), idle: false }),
  );
  store.patch("run", run.id, {
    status: "running",
    worker: replacement,
    summary: "Replacement",
    attempt: 2,
  });
  const state = attachWorker(engine, store.get("run", run.id));
  await state.poll();
  await until(() =>
    readFile(join(worker.directory, "stop"), "utf8").catch(() => false),
  );
  const before = store.get("run", run.id);
  engine.onEvent(
    run.id,
    { type: "item.completed", item: { type: "agent_message", text: "Stale" } },
    previous,
  );
  await engine.finish(run.id, previous, 0);
  await writeFile(
    join(worker.directory, "events.jsonl"),
    journal([
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Stale" },
      },
      completed,
      { type: "worker.exit", exitCode: 0 },
    ]),
  );
  await previous.poll();
  await previous.done;
  assert.deepEqual(store.get("run", run.id), before);
  assert.equal(engine.processes.get(run.id), state);
  assert.equal(engine.workers.has(previous), false);
  assert.equal(store.events({ runId: run.id }).length, 0);
  await assert.rejects(readFile(join(replacement.directory, "stop")), {
    code: "ENOENT",
  });
});

test("app.close drains running and idle workers before immediate database disposal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-worker-close-"));
  const app = await createApp({ dataDir: root, bin });
  let databaseClosed = false;
  t.after(async () => {
    await app.close();
    if (!databaseClosed) app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const idle = await quickSession(app, {
    approved: true,
    sandbox: "read-only",
  });
  app.engine.queue(idle.id, "Fixture turn");
  await until(() => app.store.get("run", idle.id).status === "review");
  const running = await quickSession(app, {
    approved: true,
    sandbox: "read-only",
  });
  app.engine.queue(running.id, "TEST_HANG");
  await until(() => app.store.get("run", running.id).threadId);
  const states = [...app.engine.workers];
  await app.close();
  assert.equal(app.engine.processes.size, 0);
  assert.equal(app.engine.workers.size, 0);
  assert.equal(app.engine.finishes.size, 0);
  assert.equal(app.store.get("run", idle.id).status, "review");
  assert.equal(app.store.get("run", running.id).status, "interrupted");
  for (const state of states) {
    assert.equal(state.disposed, true);
    assert.match(
      await readFile(join(state.worker.directory, "events.jsonl"), "utf8"),
      /worker.exit/,
    );
  }
  app.store.close();
  databaseClosed = true;
  await delay(300);
});

test("team reviewer replacement retires original workers and shutdown leaves no pollers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-worker-team-"));
  const source = join(root, "source");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await writeFile(join(source, "README.md"), "# Worker lifecycle fixture\n");
  await git(source, ["add", "."]);
  await git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-m",
    "Fixture",
  ]);
  const app = await createApp({ dataDir: join(root, "data"), bin });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.addProject({ path: source });
  const team = await app.teams.enable(project.id, { approved: true });
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "initial" && r.status === "completed"),
  );
  const originals = ["security", "verification"].map((role) =>
    app.engine.processes.get(team.members[role]),
  );
  await app.teams.task(project.id, {
    title: "Implementation",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "changes" && r.status === "completed"),
  );
  for (const previous of originals) {
    assert.equal(previous.disposed, true);
    assert.equal(app.engine.workers.has(previous), false);
    assert.match(
      await readFile(join(previous.worker.directory, "events.jsonl"), "utf8"),
      /worker.exit/,
    );
    assert.equal(
      await readFile(join(previous.worker.directory, "stop"), "utf8"),
      "stop",
    );
  }
  assert.equal(app.engine.workers.size, app.engine.processes.size);
  await app.close();
  assert.equal(app.engine.workers.size, 0);
  assert.equal(app.engine.processes.size, 0);
});
