import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDaemonLock } from "../server/daemon-lock.mjs";

function launch(dir, port) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../server/index.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        FLEET_DATA_DIR: dir,
        FLEET_PORT: String(port),
        FLEET_CODEX_BIN: fileURLToPath(
          new URL("./fixtures/codex.mjs", import.meta.url),
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const ended = once(child, "exit");
  return { child, ended, output: () => output };
}

test(
  "daemon entry releases ownership on a listen error",
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-startup-error-"));
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const instance = launch(dir, server.address().port);
    t.after(async () => {
      if (instance.child.exitCode === null) instance.child.kill();
      await instance.ended;
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    });
    const [code] = await instance.ended;
    assert.notEqual(code, 0);
    assert.match(instance.output(), /EADDRINUSE/);
    await assert.rejects(access(join(dir, "daemon.lock")), { code: "ENOENT" });
    const next = acquireDaemonLock(dir);
    next.release();
  },
);

test(
  "real daemon startup is authenticated, excludes a second owner and releases on exit",
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-startup-"));
    const first = launch(dir, 0);
    t.after(async () => {
      if (first.child.exitCode === null) first.child.kill();
      await first.ended;
      await rm(dir, { recursive: true, force: true });
    });
    let address;
    for (let i = 0; i < 100; i++) {
      address = first.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) break;
      if (first.child.exitCode !== null) throw Error(first.output());
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(address, first.output());
    assert.equal((await fetch(address + "/api/state")).status, 403);
    const bootstrap = await fetch(address + "/api/bootstrap", {
      headers: { "X-Fleet-Bootstrap": "1" },
    });
    const { csrf } = await bootstrap.json();
    assert.equal(
      (
        await fetch(address + "/api/state", {
          headers: { "X-Fleet-Token": csrf },
        })
      ).status,
      200,
    );
    const second = launch(dir, 0);
    t.after(async () => {
      if (second.child.exitCode === null) second.child.kill();
      await second.ended;
    });
    const [code] = await second.ended;
    assert.notEqual(code, 0);
    assert.match(second.output(), /already running/);
    first.child.kill("SIGTERM");
    await first.ended;
    const next = acquireDaemonLock(dir);
    next.release();
  },
);
