import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openEventStream } from "../server/event-stream.mjs";

function fixture(t, events = []) {
  const req = Object.assign(new EventEmitter(), {
    headers: {},
    url: "/api/stream",
  });
  const res = Object.assign(new EventEmitter(), {
    writes: [],
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    write(text) {
      assert.equal(this.writableEnded, false, "must not write after end");
      this.writes.push(text);
    },
    end() {
      this.writableEnded = true;
    },
  });
  const store = {
    changes: new EventEmitter(),
    replay: (cursor) => events.filter((e) => e.seq > cursor).slice(0, 500),
  };
  const streams = new Set();
  t.after(() => {
    for (const stream of streams) stream.close();
  });
  return { req, res, store, streams };
}

test("shutdown detaches stream listeners before worker shutdown emits more updates", (t) => {
  const f = fixture(t);
  const stream = openEventStream(f.req, f.res, f.store, f.streams);
  f.store.changes.emit("change", { kind: "run" });
  assert.equal(f.res.writes.length, 1);
  stream.close();
  // No request.close event has arrived yet: this is the production crash race.
  f.store.changes.emit("change", { kind: "run" });
  f.store.changes.emit("event", { seq: 1 });
  assert.equal(f.res.writes.length, 1);
  assert.equal(f.store.changes.listenerCount("change"), 0);
  assert.equal(f.store.changes.listenerCount("event"), 0);
  assert.equal(f.streams.size, 0);
  stream.close();
});

test("ended or destroyed responses stop receiving updates before close notification", (t) => {
  for (const property of ["writableEnded", "destroyed", "writableFinished"]) {
    const f = fixture(t);
    openEventStream(f.req, f.res, f.store, f.streams);
    f.res[property] = true;
    f.store.changes.emit("event", { seq: 1 });
    assert.deepEqual(f.res.writes, []);
    assert.equal(f.streams.size, 0);
  }
});

test("response errors and disconnects clean up only the affected subscription", (t) => {
  for (const event of ["error", "finish", "close"]) {
    const f = fixture(t),
      other = fixture(t);
    openEventStream(f.req, f.res, f.store, f.streams);
    openEventStream(other.req, other.res, f.store, f.streams);
    f.res.emit(event, new Error("Connection closed"));
    f.store.changes.emit("event", { seq: 2 });
    assert.equal(f.res.writes.length, 0);
    assert.equal(other.res.writes.length, 1);
    assert.equal(f.streams.size, 1);
    other.req.emit("close");
    assert.equal(f.streams.size, 0);
  }
});

test("reconnecting stream replays all batches after the last event then receives live events", (t) => {
  const f = fixture(
    t,
    Array.from({ length: 1005 }, (_, i) => ({ seq: i + 1 })),
  );
  f.req.headers["last-event-id"] = "3";
  f.req.url = "/api/stream?after=10";
  openEventStream(f.req, f.res, f.store, f.streams);
  assert.equal(f.res.writes.length, 1002);
  assert.match(f.res.writes[0], /^id: 4\n/);
  f.store.changes.emit("event", { seq: 1006 });
  assert.match(f.res.writes.at(-1), /^id: 1006\n/);
});

test("write and replay failures end their subscription without escaping into the HTTP handler", (t) => {
  for (const failure of ["write", "replay"]) {
    const f = fixture(t, [{ seq: 1 }]);
    const target = failure === "write" ? f.res : f.store;
    target[failure] = () => {
      throw new Error("Connection or replay failed");
    };
    assert.doesNotThrow(() =>
      openEventStream(f.req, f.res, f.store, f.streams),
    );
    assert.equal(f.res.writableEnded, true);
    assert.equal(f.streams.size, 0);
    assert.equal(f.store.changes.listenerCount("event"), 0);
  }
});
