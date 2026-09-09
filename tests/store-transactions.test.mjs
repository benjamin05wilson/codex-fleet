import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-transactions-"));
  const store = new Store(join(dir, "store.sqlite"));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const observed = [];
  store.changes.on("change", (value) =>
    observed.push(["change", value.kind, value.id]),
  );
  store.changes.on("event", (value) =>
    observed.push(["event", value.type, value.seq]),
  );
  return { store, observed };
}

test("raw SQL transactions cannot bypass notification buffering", async (t) => {
  const { store, observed } = await fixture(t);
  store.db.exec("BEGIN");
  try {
    assert.throws(() => store.put("run", { id: "bad" }), /Store.transaction/);
    assert.throws(() => store.event("p", null, "bad"), /Store.transaction/);
    assert.deepEqual(observed, []);
    assert.equal(store.list("run").length, 0);
  } finally {
    store.db.exec("ROLLBACK");
  }
});

test("commit defers put, patch and event notifications in deterministic order", async (t) => {
  const { store, observed } = await fixture(t);
  let event;
  assert.equal(
    store.transaction(() => {
      store.put("run", { id: "r", status: "draft" });
      store.patch("run", "r", { status: "queued" });
      event = store.event("p", "r", "queued");
      assert.deepEqual(observed, []);
      return 42;
    }),
    42,
  );
  assert.deepEqual(observed, [
    ["change", "run", "r"],
    ["change", "run", "r"],
    ["event", "queued", event.seq],
    ["change", "event", event.seq],
  ]);
  assert.equal(store.get("run", "r").status, "queued");
});

test("a mid-transaction failure rolls back rows and emits no phantom state", async (t) => {
  const { store, observed } = await fixture(t);
  store.put("run", { id: "r", status: "draft" });
  observed.length = 0;
  assert.throws(
    () =>
      store.transaction(() => {
        store.patch("run", "r", { status: "queued" });
        store.event("p", "r", "queued");
        store.put("run", { id: "new" });
        store.patch("run", "missing", {});
      }),
    /not found/,
  );
  assert.equal(store.get("run", "r").status, "draft");
  assert.equal(store.list("run").length, 1);
  assert.deepEqual(store.events({ projectId: "p" }), []);
  assert.deepEqual(observed, []);
  store.patch("run", "r", { status: "review" });
  assert.deepEqual(observed, [["change", "run", "r"]]);
});

test("nested savepoints discard only failed child notifications and outer rollback discards all", async (t) => {
  const { store, observed } = await fixture(t);
  store.transaction(() => {
    store.put("run", { id: "outer" });
    assert.throws(() =>
      store.transaction(() => {
        store.put("run", { id: "bad" });
        throw Error("fail");
      }),
    );
    store.transaction(() => store.put("run", { id: "child" }));
    assert.deepEqual(observed, []);
  });
  assert.deepEqual(
    observed.map((n) => n[2]),
    ["outer", "child"],
  );
  observed.length = 0;
  assert.throws(() =>
    store.transaction(() => {
      store.transaction(() => store.put("run", { id: "rolled-back-child" }));
      throw Error("outer failed");
    }),
  );
  assert.deepEqual(observed, []);
  assert.throws(() => store.get("run", "rolled-back-child"));
});

test("listener errors happen after commit, remaining notifications flush, and async callbacks are rejected", async (t) => {
  const { store, observed } = await fixture(t);
  const failure = () => {
    throw Error("listener");
  };
  store.changes.on("change", failure);
  assert.throws(
    () =>
      store.transaction(() => {
        store.put("run", { id: "one" });
        store.put("run", { id: "two" });
      }),
    /listener/,
  );
  assert.equal(store.list("run").length, 2);
  assert.equal(observed.length, 2);
  store.changes.off("change", failure);
  assert.throws(
    () => store.transaction(async () => store.put("run", { id: "async" })),
    /synchronous/,
  );
  assert.throws(() => store.get("run", "async"));
  store.transaction(() => store.put("run", { id: "after" }));
});
