import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
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
