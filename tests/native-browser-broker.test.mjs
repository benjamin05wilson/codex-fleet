import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NativeBrowserBroker } from "../server/native-browser-broker.mjs";
import { validateNativeAction } from "../shared/native-browser-actions.mjs";

function fixture(t) {
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
  const broker = new NativeBrowserBroker({
    store: {
      get: (kind, id) =>
        kind === "project"
          ? ["one", "two"].includes(id)
            ? { id }
            : undefined
          : runs.get(id),
    },
  });
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
  await assert.rejects(
    broker.agent(a.token, { action: "snapshot" }),
    /expired/,
  );
  runs.get("a").worker.identity = "a1";
  runs.get("a").status = "review";
  await assert.rejects(
    broker.agent(a.token, { action: "snapshot" }),
    /expired/,
  );
  assert.equal(broker.state("one").status, "open");
  assert.equal(broker.desktop(desktop.token).projectId, "one");
  assert.equal(broker.desktop(desktop.token).queue.length, 0);
});
test("commands have no broker deadline and the page survives between chat turns", async (t) => {
  const { broker, connection, runs, desktop } = fixture(t),
    firstConnection = connection("a"),
    pending = broker.agent(firstConnection.token, { action: "snapshot" });
  const command = await broker.next(
    desktop.token,
    new AbortController().signal,
  );
  assert.equal("timer" in broker.desktop(desktop.token).current, false);
  runs.get("a").status = "review";
  assert.equal(broker.state("one").status, "open");
  broker.result(desktop.token, {
    id: command.id,
    result: { text: "page" },
  });
  await assert.rejects(pending, /expired/);
  assert.equal(broker.state("one").status, "open");

  runs.get("a").status = "running";
  runs.get("a").worker.identity = "a2";
  const nextConnection = broker.connection(runs.get("a"), "a2"),
    resumed = broker.agent(nextConnection.token, { action: "snapshot" });
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
    stale = assert.rejects(second, /expired/);
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
    /expired/,
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
  const rejected = assert.rejects(first, /expired/);
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
