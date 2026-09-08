import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../server/store.mjs";
import { Terminals } from "../server/terminals.mjs";
import { createApp } from "../server/app.mjs";

function controlledPty() {
  const data = new Set(),
    exits = new Set(),
    kills = [];
  const subscribe = (listeners, callback) => {
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  };
  return {
    kills,
    listenerCount: () => data.size + exits.size,
    emitExit: (exitCode = 0) => {
      for (const callback of [...exits]) callback({ exitCode });
    },
    emitData: (value) => {
      for (const callback of [...data]) callback(value);
    },
    shell: {
      kill: (signal) => kills.push(signal),
      onData: (callback) => subscribe(data, callback),
      onExit: (callback) => subscribe(exits, callback),
    },
  };
}

async function fixture(t, { loadPty } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-terminal-lifecycle-"));
  const store = new Store(join(root, "test.sqlite"));
  const run = store.put("run", {
    id: "terminal",
    projectId: "project",
    worktree: root,
    status: "draft",
  });
  const controlled = controlledPty();
  const engine = { store, assertIdleWorktree() {} };
  const terminals = new Terminals(engine, {
    loadPty: loadPty || (async () => ({ spawn: () => controlled.shell })),
  });
  let databaseClosed = false;
  const closeDatabase = () => {
    store.close();
    databaseClosed = true;
  };
  t.after(async () => {
    controlled.emitExit();
    await terminals.close();
    if (!databaseClosed) closeDatabase();
    await rm(root, { recursive: true, force: true });
  });
  return { store, run, engine, terminals, controlled, closeDatabase };
}

test("terminal shutdown waits for exit bookkeeping before SQLite disposal", async (t) => {
  const { store, run, terminals, controlled, closeDatabase } = await fixture(t);
  await terminals.open(run, "owner");
  controlled.emitData("before shutdown");
  const session = terminals.get(run.id);
  let closed = false;
  const closing = terminals.close();
  closing.then(() => {
    closed = true;
  });
  assert.equal(terminals.close(), closing);
  await delay(10);
  assert.equal(controlled.kills.length, 1);
  assert.equal(closed, false);
  assert.equal(terminals.sessions.size, 1);
  assert.equal(store.get("run", run.id).shellOpen, true);
  await assert.rejects(terminals.open(run, "owner"), /shutting down/);
  controlled.emitExit(17);
  await closing;
  assert.equal(session.exitCode, 17);
  assert.equal(terminals.sessions.size, 0);
  assert.equal(store.get("run", run.id).shellOpen, false);
  assert.equal(
    store
      .events({ runId: run.id })
      .filter((event) => event.type === "terminal.exited").length,
    1,
  );
  assert.equal(controlled.listenerCount(), 0);
  closeDatabase();
  controlled.emitExit(18);
  controlled.emitData("late data");
  assert.equal(session.events.length, 1);
  assert.equal(session.exitError, undefined);
  await terminals.close();
});

test("shutdown drains a shell already closing without requesting a second kill", async (t) => {
  const { run, terminals, controlled } = await fixture(t);
  const { lease } = await terminals.open(run, "owner");
  terminals.control(run.id, lease, "close", {});
  const closing = terminals.close();
  await delay(10);
  assert.equal(controlled.kills.length, 1);
  assert.equal(terminals.sessions.size, 1);
  controlled.emitExit();
  await closing;
  assert.equal(terminals.sessions.size, 0);
});

test("shutdown cancels and drains an open waiting for the PTY import", async (t) => {
  const imported = Promise.withResolvers();
  let spawns = 0;
  const { run, store, terminals } = await fixture(t, {
    loadPty: () => imported.promise,
  });
  // Always release the gate, including when a regression assertion fails.
  const pending = terminals.open(run, "owner");
  const rejected = assert.rejects(pending, /shutting down/);
  const closing = terminals.close();
  let closed = false;
  closing.then(() => {
    closed = true;
  });
  await delay(10);
  const wasClosed = closed;
  imported.resolve({
    spawn: () => {
      spawns++;
      throw Error("Unexpected spawn");
    },
  });
  await rejected;
  await closing;
  assert.equal(wasClosed, false);
  assert.equal(spawns, 0);
  assert.equal(terminals.opening.size, 0);
  assert.equal(terminals.pendingOpens.size, 0);
  assert.equal(terminals.sessions.size, 0);
  assert.equal(store.events({ runId: run.id }).length, 0);
});

test("app shutdown flag prevents an in-flight import from opening before terminals.close", async (t) => {
  const imported = Promise.withResolvers();
  const { run, engine, terminals } = await fixture(t, {
    loadPty: () => imported.promise,
  });
  const pending = terminals.open(run, "owner");
  engine.closing = true;
  imported.resolve({
    spawn: () => {
      throw Error("Unexpected spawn");
    },
  });
  await assert.rejects(pending, /shutting down/);
  await assert.rejects(terminals.open(run, "owner"), /shutting down/);
  assert.equal(terminals.opening.size, 0);
});

test("shutdown does not kill a naturally exited terminal", async (t) => {
  const { run, terminals, controlled } = await fixture(t);
  await terminals.open(run, "owner");
  controlled.emitExit();
  await terminals.close();
  assert.equal(controlled.kills.length, 0);
  assert.equal(terminals.sessions.size, 0);
});

test("synchronous PTY exit leaves no escalation timer behind", async (t) => {
  const { run, terminals, controlled } = await fixture(t);
  await terminals.open(run, "owner");
  const session = terminals.get(run.id);
  t.mock.method(controlled.shell, "kill", () => controlled.emitExit());
  await terminals.close();
  assert.equal(session.exitCode, 0);
  assert.equal(session.killTimer, undefined);
  assert.equal(controlled.listenerCount(), 0);
});

test(
  "app.close drains the native PTY before immediately closing SQLite",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fleet-native-terminal-close-"));
    const app = await createApp({
      dataDir: root,
      bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
    });
    let databaseClosed = false;
    t.after(async () => {
      await app.close();
      if (!databaseClosed) app.store.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const run = app.store.put("run", {
      id: "terminal",
      projectId: "project",
      status: "draft",
      sessionKind: "terminal",
      worktree: root,
      sandbox: "read-only",
    });
    await app.engine.terminals.open(run, "test-owner");
    const session = app.engine.terminals.get(run.id);
    await app.close();
    assert.notEqual(session.exitCode, undefined);
    assert.equal(session.exitError, undefined);
    assert.equal(app.engine.terminals.sessions.size, 0);
    assert.equal(app.store.get("run", run.id).shellOpen, false);
    assert.equal(
      app.store
        .events({ runId: run.id })
        .filter((event) => event.type === "terminal.exited").length,
      1,
    );
    app.store.close();
    databaseClosed = true;
    await delay(100);
    assert.equal(session.exitError, undefined);
  },
);
