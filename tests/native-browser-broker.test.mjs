import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { NativeBrowserBroker } from "../server/native-browser-broker.mjs";
import { validateNativeAction } from "../shared/native-browser-actions.mjs";

function fixture(t, options) {
  const runs = new Map([
    [
      "a",
      {
        id: "a",
        projectId: "one",
        status: "running",
        worker: { identity: "a1" },
      },
    ],
    [
      "b",
      {
        id: "b",
        projectId: "one",
        status: "running",
        worker: { identity: "b1" },
      },
    ],
    [
      "c",
      {
        id: "c",
        projectId: "two",
        status: "running",
        worker: { identity: "c1" },
      },
    ],
  ]);
  const broker = new NativeBrowserBroker(
    {
      store: {
        changes: new EventEmitter(),
        get: (kind, id) =>
          kind === "project"
            ? ["one", "two"].includes(id)
              ? { id }
              : undefined
            : runs.get(id),
      },
    },
    options,
  );
  broker.base = () => "http://127.0.0.1:1";
  t.after(() => broker.close());
  const connection = (id) => broker.connection(runs.get(id), id + "1");
  const desktop = broker.register({ projectId: "one", nativeId: randomUUID() });
  return { broker, runs, connection, desktop };
}

test("two project agents get automatic shared access, with serialized actions and no approval or takeover", async (t) => {
  const { broker, connection, desktop } = fixture(t),
    a = connection("a"),
    b = connection("b");
  const first = broker.agent(a.token, {
    action: "navigate",
    url: "https://example.com",
  });
  const second = broker.agent(b.token, { action: "scroll", text: "down" });
  const one = await broker.next(desktop.token, new AbortController().signal);
  assert.equal(one.input.action, "navigate");
  broker.result(desktop.token, {
    id: one.id,
    result: { url: "https://example.com" },
  });
  assert.equal((await first).url, "https://example.com");
  const two = await broker.next(desktop.token, new AbortController().signal);
  assert.equal(two.input.action, "scroll");
  broker.result(desktop.token, { id: two.id, result: { scrolled: true } });
  await second;
  assert.equal(broker.state("one").controller, "shared");
  assert.equal(broker.state("one").approvalRequired, false);
});
test("cross-project, stale worker and completed-turn capabilities cannot dispatch", async (t) => {
  const { broker, connection, runs, desktop } = fixture(t),
    a = connection("a"),
    c = connection("c");
  await assert.rejects(
    broker.agent(c.token, { action: "snapshot" }),
    /Fleet Desktop is not connected/,
  );
  runs.get("a").worker.identity = "new";
  await assert.rejects(broker.agent(a.token, { action: "snapshot" }), {
    status: 403,
  });
  runs.get("a").worker.identity = "a1";
  runs.get("a").status = "review";
  await assert.rejects(broker.agent(a.token, { action: "snapshot" }), {
    status: 403,
  });
  assert.equal(broker.state("one").status, "open");
  assert.equal(broker.desktop(desktop.token).projectId, "one");
  assert.equal(broker.desktop(desktop.token).queue.length, 0);
});
test("persistent credentials and the shared page survive between chat turns", async (t) => {
  const { broker, connection, runs, desktop } = fixture(t),
    firstConnection = connection("a"),
    pending = broker.agent(firstConnection.token, { action: "snapshot" });
  runs.get("a").worker.persistent = true;
  const command = await broker.next(
    desktop.token,
    new AbortController().signal,
  );
  runs.get("a").status = "review";
  assert.equal(broker.state("one").status, "open");
  broker.result(desktop.token, {
    id: command.id,
    result: { text: "page" },
  });
  await assert.rejects(pending, { status: 403 });
  assert.equal(broker.state("one").status, "open");

  connection("b");
  runs.get("a").status = "running";
  const resumed = broker.agent(firstConnection.token, { action: "snapshot" });
  const resumedCommand = await broker.next(
    desktop.token,
    new AbortController().signal,
  );
  broker.result(desktop.token, {
    id: resumedCommand.id,
    result: { text: "same page" },
  });
  assert.deepEqual(await resumed, { text: "same page" });
  assert.equal(broker.state("one").status, "open");
});
test("queued commands are revalidated and disconnect rejects in-flight actions without replay", async (t) => {
  const { broker, connection, runs, desktop } = fixture(t),
    a = connection("a"),
    b = connection("b");
  const first = broker.agent(a.token, { action: "snapshot" });
  const one = await broker.next(desktop.token, new AbortController().signal);
  const second = broker.agent(b.token, { action: "scroll", text: "down" }),
    stale = assert.rejects(second, { status: 403 });
  runs.get("b").status = "paused";
  const waiter = broker.next(desktop.token, new AbortController().signal);
  broker.result(desktop.token, { id: one.id, result: { text: "page" } });
  await first;
  await stale;
  const third = broker.agent(a.token, { action: "snapshot" }),
    closed = assert.rejects(third, /disconnected/);
  const command = await waiter;
  assert.equal(command.input.action, "snapshot");
  broker.disconnect(desktop.token);
  await closed;
  assert.throws(
    () => broker.result(desktop.token, { id: command.id, result: {} }),
    { status: 403 },
  );
});
test("duplicate project windows, malformed actions and privileged operations fail closed", (t) => {
  const { broker } = fixture(t);
  assert.throws(
    () => broker.register({ projectId: "one", nativeId: randomUUID() }),
    /another Fleet window/,
  );
  for (const input of [
    { action: "eval", text: "1+1" },
    { action: "click", target: "body" },
    { action: "navigate", url: "https://example.com", projectId: "two" },
    { action: "press", text: "Meta+q" },
    { action: "fill", target: "@e1" },
  ])
    assert.throws(() => validateNativeAction(input));
});

test("navigate creates a missing native page through the desktop and then dispatches once", async (t) => {
  const { broker, connection, desktop } = fixture(t);
  broker.disconnect(desktop.token);
  const launcher = broker.registerLauncher({ nativeId: randomUUID() });
  const a = connection("a");
  const navigation = broker.agent(a.token, {
    action: "navigate",
    url: "https://example.com",
  });
  const open = await broker.next(launcher.token, new AbortController().signal);
  assert.deepEqual(open.input, {
    projectId: "one",
    runId: "a",
    url: "https://example.com",
  });
  const page = broker.register({ projectId: "one", nativeId: randomUUID() });
  broker.result(launcher.token, { id: open.id, result: { opened: true } });
  const command = await broker.next(page.token, new AbortController().signal);
  assert.deepEqual(command.input, {
    action: "navigate",
    url: "https://example.com",
  });
  broker.result(page.token, {
    id: command.id,
    result: { url: "https://example.com" },
  });
  assert.equal((await navigation).url, "https://example.com");
  assert.equal(broker.desktop(page.token).queue.length, 0);
});

test("closed-page interactions do not launch a browser, and desktop absence is actionable", async (t) => {
  const { broker, connection, desktop } = fixture(t);
  broker.disconnect(desktop.token);
  const a = connection("a");
  await assert.rejects(
    broker.agent(a.token, { action: "navigate", url: "https://example.com" }),
    /Fleet Desktop is not connected/,
  );
  const launcher = broker.registerLauncher({ nativeId: randomUUID() });
  await assert.rejects(
    broker.agent(a.token, { action: "click", target: "@e1" }),
    /Use navigate/,
  );
  assert.equal(broker.desktop(launcher.token).queue.length, 0);
  await assert.rejects(
    broker.agent(a.token, {
      action: "navigate",
      url: "https://example.com",
      projectId: "two",
    }),
  );
  assert.equal(broker.desktop(launcher.token).queue.length, 0);
});

test("opening revalidates the chat before navigation and disconnect never replays it", async (t) => {
  const { broker, connection, runs } = fixture(t);
  const launcher = broker.registerLauncher({ nativeId: randomUUID() });
  const a = connection("a");
  const first = broker.agent(a.token, {
    action: "navigate",
    url: "https://example.com",
  });
  const rejected = assert.rejects(first, { status: 403 });
  const open = await broker.next(launcher.token, new AbortController().signal);
  runs.get("a").status = "paused";
  broker.result(launcher.token, { id: open.id, result: { opened: true } });
  await rejected;
  const b = connection("b");
  const second = broker.agent(b.token, {
    action: "navigate",
    url: "https://example.com",
  });
  const disconnected = assert.rejects(second, /disconnected/);
  await broker.next(launcher.token, new AbortController().signal);
  broker.disconnect(launcher.token);
  await disconnected;
  assert.equal(broker.sessions.get("one").queue.length, 0);
});

test("crashed desktop and launcher registrations expire and replacement identities can reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { broker, connection, desktop } = fixture(t);
  const launcher = broker.registerLauncher({ nativeId: randomUUID() });
  assert.throws(() => broker.registerLauncher({ nativeId: randomUUID() }), {
    status: 409,
  });
  const pending = broker.agent(connection("a").token, { action: "snapshot" });
  const disconnected = assert.rejects(pending, { status: 409 });
  t.mock.timers.tick(60000);
  await disconnected;
  assert.equal(broker.state("one").status, "closed");
  assert.equal(broker.launcher, null);
  for (const token of [desktop.token, launcher.token])
    assert.throws(() => broker.desktop(token), { status: 403 });
  const page = broker.register({ projectId: "one", nativeId: randomUUID() });
  const opener = broker.registerLauncher({ nativeId: randomUUID() });
  assert.equal(broker.desktop(page.token).queue.length, 0);
  assert.equal(broker.desktop(opener.token).queue.length, 0);
});

test("idle long polls renew transport liveness without replacing the shared page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { broker, desktop } = fixture(t);
  const page = broker.desktop(desktop.token);
  for (let i = 0; i < 8; i++) {
    const next = broker.next(desktop.token, new AbortController().signal);
    t.mock.timers.tick(25000);
    assert.equal(await next, null);
    assert.equal(broker.desktop(desktop.token), page);
    assert.equal(broker.state("one").status, "open");
  }
  assert.throws(
    () => broker.register({ projectId: "one", nativeId: randomUUID() }),
    { status: 409 },
  );
});

test("caller cancellation removes queued page and launcher commands without disconnecting either", async (t) => {
  const { broker, connection, desktop } = fixture(t);
  const a = connection("a");
  for (const launcher of [false, true]) {
    if (launcher) broker.registerLauncher({ nativeId: randomUUID() });
    const controller = new AbortController();
    const pending = broker.agent(
      a.token,
      { action: "snapshot" },
      controller.signal,
    );
    const rejected = assert.rejects(pending, { status: 499 });
    const s = launcher ? broker.launcher : broker.desktop(desktop.token);
    assert.equal(s.queue.length, 1);
    controller.abort();
    await rejected;
    assert.equal(s.queue.length, 0);
    assert.equal(s.current, null);
    assert.equal(broker.state("one").status, "open");
    await assert.rejects(
      broker.agent(a.token, { action: "snapshot" }, controller.signal),
      { status: 499 },
    );
    assert.equal(s.queue.length, 0);
  }
});

test("one bounded deadline spans launcher reveal and page execution without destroying sessions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { broker, connection, desktop } = fixture(t, {
    commandTimeoutMs: 1000,
  });
  const launcher = broker.registerLauncher({ nativeId: randomUUID() });
  const pending = broker.agent(connection("a").token, { action: "snapshot" });
  const rejected = assert.rejects(pending, { status: 504 });
  const reveal = await broker.next(
    launcher.token,
    new AbortController().signal,
  );
  assert.deepEqual(reveal.input, { projectId: "one", runId: "a" });
  t.mock.timers.tick(900);
  broker.result(launcher.token, { id: reveal.id, result: { opened: true } });
  // Let the launcher acknowledgement enqueue the page operation.
  await Promise.resolve();
  assert.equal(broker.desktop(desktop.token).queue.length, 1);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(broker.desktop(desktop.token).queue.length, 0);
  assert.equal(broker.state("one").status, "open");
  assert.equal(broker.desktop(launcher.token).current, null);
});

test("timed out dispatched actions hold serialization until a late result, then fresh work proceeds once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { broker, connection, desktop } = fixture(t, {
    commandTimeoutMs: 1000,
  });
  const a = connection("a");
  const pending = broker.agent(a.token, { action: "scroll", text: "down" });
  const rejected = assert.rejects(pending, { status: 504 });
  const first = await broker.next(desktop.token, new AbortController().signal);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(broker.desktop(desktop.token).current.id, first.id);
  const next = broker.next(desktop.token, new AbortController().signal);
  const fresh = broker.agent(a.token, { action: "snapshot" });
  assert.equal(broker.desktop(desktop.token).queue.length, 1);
  broker.result(desktop.token, { id: first.id, result: { scrolled: true } });
  const second = await next;
  assert.notEqual(second.id, first.id);
  assert.equal(second.input.action, "snapshot");
  broker.result(desktop.token, {
    id: second.id,
    result: { text: "same page" },
  });
  assert.deepEqual(await fresh, { text: "same page" });
  assert.throws(
    () => broker.result(desktop.token, { id: first.id, result: {} }),
    { status: 409 },
  );
  assert.equal(broker.state("one").status, "open");
});

test("turn completion cancels undispatched work immediately but retains idle worker credentials", async (t) => {
  const { broker, connection, runs, desktop } = fixture(t);
  const run = runs.get("a");
  run.worker.persistent = true;
  run.attempt = 1;
  const a = connection("a");
  const pending = broker.agent(a.token, { action: "snapshot" });
  const rejected = assert.rejects(pending, { status: 403 });
  run.status = "review";
  run.worker.idle = true;
  broker.engine.store.changes.emit("change", { kind: "run", id: "a" });
  await rejected;
  assert.equal(broker.desktop(desktop.token).queue.length, 0);
  for (const status of ["review", "queued", "preparing"]) {
    run.status = status;
    connection("b"); // Pruning another connection must retain this credential.
    assert.equal(connection("a").token, a.token);
    await assert.rejects(broker.agent(a.token, { action: "snapshot" }), {
      status: 403,
    });
  }
  run.status = "running";
  await assert.rejects(broker.agent(a.token, { action: "snapshot" }), {
    status: 403,
  });
  run.worker.idle = false;
  run.attempt++;
  const resumed = broker.agent(a.token, { action: "snapshot" });
  const command = await broker.next(
    desktop.token,
    new AbortController().signal,
  );
  broker.result(desktop.token, { id: command.id, result: { text: "resumed" } });
  assert.deepEqual(await resumed, { text: "resumed" });
});

test("queued work cannot cross a turn attempt even if idle state was not observed", async (t) => {
  const { broker, connection, runs, desktop } = fixture(t);
  runs.get("a").attempt = 1;
  const pending = broker.agent(connection("a").token, { action: "snapshot" });
  const rejected = assert.rejects(pending, { status: 403 });
  runs.get("a").attempt++;
  const controller = new AbortController();
  const next = broker.next(desktop.token, controller.signal);
  await rejected;
  controller.abort();
  assert.equal(await next, null);
  assert.equal(broker.desktop(desktop.token).current, null);
});
