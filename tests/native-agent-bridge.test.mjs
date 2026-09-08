import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as flush } from "node:timers/promises";
import { NativeBrowserBroker } from "../server/native-browser-broker.mjs";
import { connectNativeAgent } from "../desktop/native-agent-bridge.mjs";

test("desktop polls throughout slow execution and command timeout without reconnecting or replaying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = {
    id: "run",
    projectId: "project",
    status: "running",
    worker: { identity: "worker" },
  };
  const broker = new NativeBrowserBroker({
    store: { get: (kind) => (kind === "run" ? run : { id: "project" }) },
  });
  broker.base = () => "http://fixture";
  t.after(() => broker.close());
  const statuses = [],
    executed = [];
  let polls = 0;
  const slow = Promise.withResolvers();
  const disconnect = connectNativeAgent({
    origin: "http://fixture",
    projectId: "project",
    nativeId: randomUUID(),
    onStatus: (status) => statuses.push(status),
    execute: async (input) => {
      executed.push(input);
      if (executed.length === 1) await slow.promise;
      return { count: executed.length };
    },
    fetchImpl: async (url, options) => {
      const action = url.split("/").at(-1);
      if (action === "state")
        return { ok: true, json: async () => ({ csrf: "fixture" }) };
      const body = JSON.parse(options.body);
      let value;
      if (action === "register") value = broker.register(body);
      if (action === "next") {
        polls++;
        value = await broker.next(body.token, options.signal);
      }
      if (action === "result") value = broker.result(body.token, body);
      if (action === "close") value = broker.disconnect(body.token);
      return { ok: true, json: async () => value };
    },
  });
  t.after(async () => {
    slow.resolve();
    await disconnect();
  });
  await flush();
  const page = broker.sessions.get("project");
  const connection = broker.connection(run, "worker");
  const pending = broker.agent(connection.token, {
    action: "scroll",
    text: "down",
  });
  const timedOut = assert.rejects(pending, { status: 504 });
  await flush();
  assert.equal(executed.length, 1);
  const commandId = page.current.id;
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(25000);
    await flush();
    assert.equal(broker.sessions.get("project"), page);
    assert.equal(page.current.id, commandId);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].connected, true);
  }
  await timedOut;
  assert.ok(
    polls >= 5,
    "polling must renew the lease while execute is pending",
  );
  const fresh = broker.agent(connection.token, { action: "snapshot" });
  await flush();
  assert.equal(executed.length, 1, "fresh work must wait for the old result");
  slow.resolve();
  assert.deepEqual(await fresh, { count: 2 });
  assert.deepEqual(
    executed.map((input) => input.action),
    ["scroll", "snapshot"],
  );
  assert.equal(broker.sessions.get("project"), page);
  assert.equal(statuses.length, 1);
});
