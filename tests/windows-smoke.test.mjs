import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { git, safeRead } from "../server/git.mjs";
import { shellCommand, stopProcessTree } from "../shared/platform.mjs";
import { discoverCodex } from "../server/discovery.mjs";

const fixture = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw Error("Windows smoke timed out");
}
test(
  "native Windows: SQLite workspace, Git worktree, Codex fixture and ConPTY terminal",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "fleet windows smoke "));
    const source = join(directory, "source with spaces");
    await mkdir(source);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "Fleet Test"]);
    await git(source, ["config", "user.email", "fleet@example.invalid"]);
    await writeFile(join(source, "file.txt"), "inside");
    await git(source, ["add", "file.txt"]);
    await git(source, ["commit", "-m", "Fixture"]);
    const app = await createApp({
      dataDir: join(directory, "data"),
      bin: fixture,
    });
    t.after(async () => {
      await app.close();
      app.store.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    });
    await assert.rejects(safeRead(source, "..\\outside.txt"), /outside/);
    assert.equal((await discoverCodex(fixture, source)).authenticated, true);
    await git(source, [
      "worktree",
      "add",
      "-b",
      "test-worktree",
      join(directory, "worktree"),
    ]);
    assert.equal(
      await safeRead(join(directory, "worktree"), "file.txt"),
      "inside",
    );
    app.store.put("project", { id: "project", path: source, name: "Windows" });
    const run = {
      id: "shell",
      projectId: "project",
      status: "draft",
      worktree: source,
      scopes: [],
      files: [],
      dependencies: [],
    };
    app.store.put("run", run);
    const { lease } = await app.terminals.open(run, "test-owner");
    app.terminals.control(run.id, lease, "input", {
      data: "Write-Output ('FLEET_' + 'WINDOWS_OK')\r",
    });
    await until(() =>
      app.terminals
        .get(run.id)
        .events.some((e) => e.data.includes("FLEET_WINDOWS_OK")),
    );
    app.terminals.control(run.id, lease, "resize", { cols: 90, rows: 24 });
    app.terminals.control(run.id, lease, "close", {});
    await until(() => !app.terminals.sessions.has(run.id));
  },
);
test(
  "native Windows: command quoting, exit codes and owned process-tree termination",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const shell = shellCommand(
      `"${process.execPath}" -e "process.stdout.write('quoted-path-ok');process.exit(7)"`,
    );
    const child = spawn(shell.bin, shell.args, {
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    assert.equal(await new Promise((r) => child.once("close", r)), 7);
    assert.equal(output, "quoted-path-ok");
    // Exercise the actual validation supervisor, including its persistent
    // Windows helper and cleanup, not just a directly spawned cmd.exe.
    const runner = spawn(
      process.execPath,
      [fileURLToPath(new URL("../server/runner.mjs", import.meta.url))],
      { detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let runnerOutput = "";
    let runnerError = "";
    runner.stdout.on("data", (b) => (runnerOutput += b));
    runner.stderr.on("data", (b) => (runnerError += b));
    const runnerClosed = new Promise((resolve, reject) => {
      runner.once("close", resolve);
      runner.once("error", reject);
    });
    runner.send({ ...shell, cwd: tmpdir(), prompt: "" });
    try {
      assert.equal(await runnerClosed, 7, runnerError);
      assert.equal(runnerOutput, "quoted-path-ok");
    } finally {
      if (runner.exitCode === null) stopProcessTree(runner);
    }
    const parent = spawn(
      process.execPath,
      [
        "-e",
        "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
      ],
      { detached: true, windowsHide: true },
    );
    let descendant;
    parent.stdout.once(
      "data",
      (b) => (descendant = Number(b.toString().trim())),
    );
    try {
      await until(() => Number.isInteger(descendant));
      const closed = new Promise((r) => parent.once("close", r));
      stopProcessTree(parent);
      await closed;
      await until(() => {
        try {
          process.kill(descendant, 0);
          return false;
        } catch (e) {
          return e.code === "ESRCH";
        }
      });
    } finally {
      if (parent.exitCode === null) stopProcessTree(parent);
    }
  },
);
