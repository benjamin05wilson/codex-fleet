import test from "node:test";
import assert from "node:assert/strict";
import { headlessTerminal } from "./helpers/headless-terminal.mjs";

function session(initial = "") {
  const listeners = new Set(),
    responses = [];
  const s = {
    events: [{ seq: 1, data: initial }],
    responses,
    listeners,
    process: {
      write: (data) => responses.push(data),
      onData: (fn) => {
        listeners.add(fn);
        return { dispose: () => listeners.delete(fn) };
      },
    },
    emit(data) {
      s.events.push({ seq: s.events.length + 1, data });
      for (const fn of listeners) fn(data);
    },
  };
  return s;
}

test("headless smoke replays startup output and answers split cursor queries at the actual position", async () => {
  const s = session("ready\x1b[");
  const terminal = headlessTerminal(s);
  try {
    s.emit("6n");
    await terminal.flush();
    assert.equal(terminal.text, "ready");
    assert.deepEqual(s.responses, ["\x1b[1;6R"]);
    s.emit("\x1b[2;5H\x1b[6n");
    await terminal.flush();
    assert.deepEqual(s.responses, ["\x1b[1;6R", "\x1b[2;5R"]);
    assert.equal(terminal.transcript.match(/ready/g).length, 1);
  } finally {
    terminal.close();
  }
  assert.equal(s.listeners.size, 0);
});

test("headless smoke asserts rendered output rather than syntax-colored or overwritten raw bytes", async () => {
  const s = session();
  const terminal = headlessTerminal(s);
  try {
    s.emit("\x1b[31mold result\x1b[0m\r\x1b[2Kactual output");
    await terminal.flush();
    assert.equal(terminal.text, "actual output");
    assert.ok(terminal.transcript.includes("old result"));
  } finally {
    terminal.close();
  }
});
