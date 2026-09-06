import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export async function launchWorker(engine, run, prompt) {
  const directory = join(engine.dataDir, "workers", run.id, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = randomUUID();
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      identity,
      bin: engine.bin,
      run,
      prompt,
      timeoutMs: run.timeoutMs,
      browser: engine.browsers?.connection(run, identity) || null,
    }),
    { mode: 0o600 },
  );
  const worker = { directory, identity, cursor: 0, createdAt: Date.now() };
  engine.store.patch("run", run.id, {
    worker,
    status: "running",
    startedAt: new Date().toISOString(),
    attempt: run.attempt + 1,
  });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./worker.mjs", import.meta.url)), directory],
    { detached: true, stdio: "ignore", cwd: run.worktree },
  );
  child.on("error", (error) =>
    engine.store.patch("run", run.id, {
      status: "failed",
      error: error.message,
    }),
  );
  child.unref();
  attachWorker(engine, engine.store.get("run", run.id));
}
export function attachWorker(engine, run) {
  const state = {
    durable: true,
    started: new Date(run.startedAt || Date.now()).getTime(),
    stderr: "",
    sawComplete: false,
    sawFailure: false,
    scanBusy: false,
  };
  engine.processes.set(run.id, state);
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      let current = engine.store.get("run", run.id);
      const journal = await readFile(
        join(run.worker.directory, "events.jsonl"),
        "utf8",
      ).catch(() => "");
      let exit;
      for (const line of journal.split("\n").slice(0, -1)) {
        const entry = JSON.parse(line);
        // Retain completion state even when replay starts beyond an already ingested event.
        if (entry.event.type === "turn.completed") state.sawComplete = true;
        if (entry.event.type === "turn.failed") state.sawFailure = true;
        if (entry.event.type === "worker.exit") exit = entry.event;
        if (entry.seq <= current.worker.cursor) continue;
        engine.store.db.exec("BEGIN IMMEDIATE");
        try {
          engine.onEvent(run.id, entry.event, state);
          current = engine.store.patch("run", run.id, {
            worker: { ...current.worker, cursor: entry.seq },
          });
          engine.store.db.exec("COMMIT");
        } catch (e) {
          engine.store.db.exec("ROLLBACK");
          throw e;
        }
      }
      const status = JSON.parse(
        await readFile(join(run.worker.directory, "status.json"), "utf8").catch(
          () => "{}",
        ),
      );
      if (exit) {
        clearInterval(state.poller);
        if (exit.interrupted && !state.stopStatus) state.stopStatus = "paused";
        state.stderr = exit.error || state.stderr;
        await engine.finish(run.id, state, exit.exitCode);
        return;
      }
      if (status.identity && status.identity !== run.worker.identity)
        throw new Error("Worker identity mismatch.");
      if (Date.now() - (status.time || run.worker.createdAt) > 10000) {
        if (status.pid) {
          try {
            process.kill(status.pid, 0);
            return;
          } catch (error) {
            if (error.code !== "ESRCH") return;
          }
        }
        clearInterval(state.poller);
        state.stopStatus = "interrupted";
        state.stderr =
          "Execution worker is unavailable. Resume explicitly; it has not been relaunched.";
        await engine.finish(run.id, state, null);
      }
    } catch (error) {
      state.stderr = error.message;
    } finally {
      busy = false;
    }
  };
  state.poller = setInterval(poll, 250);
  poll();
  return state;
}
export async function stopWorker(run) {
  await writeFile(join(run.worker.directory, "stop"), "stop", { mode: 0o600 });
}
