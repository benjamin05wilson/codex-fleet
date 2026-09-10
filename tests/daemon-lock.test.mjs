import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock } from "../server/daemon-lock.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-daemon-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function contender(t, dir) {
  const child = fork(
    new URL("./fixtures/daemon-lock.mjs", import.meta.url),
    [dir],
    { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const ended = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await ended;
  });
  const [message] = await once(child, "message");
  return { child, message, ended };
}

test(
  "concurrent startup has exactly one owner and a clear already-running failure",
  { timeout: 15000 },
  async (t) => {
    const dir = await fixture(t);
    const processes = await Promise.all(
      Array.from({ length: 6 }, () => contender(t, dir)),
    );
    const winner = processes.find((p) => p.message.owned);
    assert.equal(processes.filter((p) => p.message.owned).length, 1);
    for (const p of processes.filter((p) => !p.message.owned))
      assert.equal(p.message.code, "FLEET_ALREADY_RUNNING");
    assert.equal(
      JSON.parse(await readFile(join(dir, "daemon.lock"))).nonce,
      winner.message.owner.nonce,
    );
    winner.child.send("release");
    await winner.ended;
    const next = acquireDaemonLock(dir);
    next.release();
  },
);

test(
  "process death releases OS ownership and stale metadata is reclaimed",
  { timeout: 15000 },
  async (t) => {
    const dir = await fixture(t);
    const first = await contender(t, dir);
    first.child.send("crash");
    await first.ended;
    const next = acquireDaemonLock(dir);
    assert.notEqual(next.owner.nonce, first.message.owner.nonce);
    next.release();
  },
);

test("malformed, dead legacy and reused live PID metadata do not block acquisition", async (t) => {
  const dir = await fixture(t);
  for (const content of [
    "",
    "not-json",
    "99999999",
    "9999999999999999",
    String(process.pid),
    JSON.stringify({ version: 1, pid: process.pid, nonce: "old-instance" }),
  ]) {
    await writeFile(join(dir, "daemon.lock"), content);
    const lease = acquireDaemonLock(dir);
    assert.equal(
      JSON.parse(await readFile(join(dir, "daemon.lock"))).nonce,
      lease.owner.nonce,
    );
    lease.release();
  }
});

test("cleanup is identity checked and delayed releases cannot remove a replacement lock", async (t) => {
  const dir = await fixture(t);
  const old = acquireDaemonLock(dir);
  const replacement = JSON.stringify({
    version: 1,
    pid: process.pid,
    nonce: "replacement",
  });
  await writeFile(join(dir, "daemon.lock"), replacement);
  old.release();
  assert.equal(await readFile(join(dir, "daemon.lock"), "utf8"), replacement);
  const next = acquireDaemonLock(dir);
  old.release();
  assert.equal(
    JSON.parse(await readFile(join(dir, "daemon.lock"))).nonce,
    next.owner.nonce,
  );
  next.release();
});

test(
  "a failed same-process contender cannot drop the owner's OS lock",
  { timeout: 15000 },
  async (t) => {
    const dir = await fixture(t);
    const owner = acquireDaemonLock(dir);
    try {
      assert.throws(() => acquireDaemonLock(dir), /already running/);
      const other = await contender(t, dir);
      assert.equal(other.message.owned, false);
      assert.equal(other.message.code, "FLEET_ALREADY_RUNNING");
    } finally {
      owner.release();
    }
  },
);

test("self PID migration never probes externally and still denies reentrant ownership", async (t) => {
  const dir = await fixture(t);
  const probe = t.mock.method(childProcess, "execFileSync", () => {
    throw new Error("external process probe unavailable");
  });
  syncBuiltinESMExports();
  try {
    await writeFile(join(dir, "daemon.lock"), String(process.pid));
    const lease = acquireDaemonLock(dir);
    try {
      assert.equal(
        JSON.parse(await readFile(join(dir, "daemon.lock"))).nonce,
        lease.owner.nonce,
      );
      assert.throws(() => acquireDaemonLock(dir), {
        code: "FLEET_ALREADY_RUNNING",
      });
      assert.equal(probe.mock.callCount(), 0);
    } finally {
      lease.release();
    }
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});

test("foreign PID probe errors fail closed, preserve metadata and release SQLite ownership", async (t) => {
  const dir = await fixture(t);
  const metadata = String(process.ppid);
  assert.notEqual(process.ppid, process.pid);
  const failure = Object.assign(
    new Error("external process probe unavailable"),
    { code: "ETIMEDOUT" },
  );
  const probe = t.mock.method(childProcess, "execFileSync", () => {
    throw failure;
  });
  syncBuiltinESMExports();
  try {
    await writeFile(join(dir, "daemon.lock"), metadata);
    assert.throws(
      () => acquireDaemonLock(dir),
      (error) => error === failure,
    );
    assert.equal(probe.mock.callCount(), 1);
    assert.equal(await readFile(join(dir, "daemon.lock"), "utf8"), metadata);
    // A second acquisition must reach the probe: the failed one released SQLite.
    probe.mock.mockImplementation(() => 'node "/fixture/server/index.mjs"');
    assert.throws(() => acquireDaemonLock(dir), {
      code: "FLEET_ALREADY_RUNNING",
    });
    assert.equal(probe.mock.callCount(), 2);
    assert.equal(await readFile(join(dir, "daemon.lock"), "utf8"), metadata);
    probe.mock.mockImplementation(() => "unrelated-process");
    const lease = acquireDaemonLock(dir);
    lease.release();
    assert.equal(probe.mock.callCount(), 3);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});
