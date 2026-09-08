import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { redact } from "./sentinel.mjs";

export async function launchWorker(engine, run, prompt) {
  const previous = engine.processes.get(run.id);
  if (previous?.durable) await retireWorker(previous);
  if (engine.closing) return;
  const directory = join(engine.dataDir, "workers", run.id, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = randomUUID();
  const browser = engine.browsers?.connection(run, identity) || null;
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      identity,
      bin: engine.bin,
      run,
      prompt,
      timeoutMs: run.timeoutMs,
      browser,
    }),
    { mode: 0o600 },
  );
  if (engine.closing) return;
  const worker = {
    directory,
    identity,
    cursor: 0,
    createdAt: Date.now(),
    persistent: true,
    idle: false,
    model: run.model || "",
    turnCursor: 0,
  };
  engine.store.patch("run", run.id, {
    worker,
    status: "running",
    startedAt: new Date().toISOString(),
    attempt: run.attempt + 1,
  });
  // A durable worker outlives this daemon, so its stdio cannot use parent-owned
  // pipes. Keep a bounded-on-read crash log instead of discarding the only
  // diagnostics available when the worker exits before journalling its result.
  const log = openSync(join(directory, "worker.log"), "a", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./worker.mjs", import.meta.url)), directory],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", log],
        cwd: run.worktree,
      },
    );
  } finally {
    closeSync(log);
  }
  child.on("error", (error) => {
    const state = engine.processes.get(run.id);
    if (!state || !ownsWorker(engine, run.id, state)) return;
    if (state.worker.identity !== identity) return;
    engine.store.patch("run", run.id, {
      status: "failed",
      error: error.message,
    });
  });
  child.unref();
  attachWorker(engine, engine.store.get("run", run.id));
}
export function ownsWorker(engine, key, state) {
  if (state.disposed || state.releasing || engine.processes.get(key) !== state)
    return false;
  const worker = engine.store.get("run", key).worker;
  return (
    worker?.identity === state.worker.identity &&
    worker?.directory === state.worker.directory
  );
}

export function retireWorker(state) {
  if (state.disposed || state.releasing) return state.done;
  state.releasing = true;
  // The run may already point at a replacement (or no worker at all).
  // Always stop the execution owner captured when this poller was attached.
  state.stopPending = stopWorker({ worker: state.worker })
    .catch((error) => {
      state.stderr = error.message;
    })
    .finally(() => {
      state.stopPending = null;
      state.settle();
    });
  return state.done;
}

export function attachWorker(engine, run) {
  const previous = engine.processes.get(run.id);
  if (previous?.durable) retireWorker(previous);
  const state = {
    durable: true,
    worker: { ...run.worker },
    started: new Date(run.startedAt || Date.now()).getTime(),
    stderr: "",
    sawComplete: false,
    sawFailure: false,
    scanBusy: false,
    idle: run.status === "review" && run.worker.persistent === true,
    awaitingResume: !!run.worker.pendingAttempt,
  };
  let resolveDone;
  state.done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  engine.workers.add(state);
  state.settle = () => {
    if (!state.disposed || state.pending || state.stopPending) return;
    engine.workers.delete(state);
    resolveDone();
  };
  state.dispose = () => {
    state.disposed = true;
    clearInterval(state.poller);
    if (engine.processes.get(run.id) === state) engine.processes.delete(run.id);
    state.settle();
    return state.done;
  };
  engine.processes.set(run.id, state);
  const poll = async () => {
    try {
      const journal = await readFile(
        join(run.worker.directory, "events.jsonl"),
        "utf8",
      ).catch(() => "");
      if (state.disposed) return;
      if (!state.releasing && !ownsWorker(engine, run.id, state))
        retireWorker(state);
      let current = state.releasing ? null : engine.store.get("run", run.id);
      let exit;
      let becameIdle = false;
      for (const line of journal.split("\n").slice(0, -1)) {
        const entry = JSON.parse(line);
        if (entry.event.type === "worker.exit") exit = entry.event;
        if (state.releasing) continue;
        // Reconstruct only this turn's completion, including already committed
        // entries. Previous turns must never satisfy a pending follow-up.
        if (entry.seq > (current.worker.turnCursor || 0)) {
          if (entry.event.type === "turn.started") {
            state.sawComplete = false;
            state.sawFailure = false;
            state.awaitingResume = false;
          }
          if (entry.event.type === "turn.completed") state.sawComplete = true;
          if (entry.event.type === "turn.failed") state.sawFailure = true;
        }
        if (entry.seq <= current.worker.cursor) continue;
        if (entry.event.type === "worker.idle") becameIdle = true;
        engine.store.db.exec("BEGIN IMMEDIATE");
        try {
          engine.onEvent(run.id, entry.event, state);
          current = engine.store.patch("run", run.id, {
            worker: {
              ...current.worker,
              cursor: entry.seq,
              ...(entry.event.type === "turn.started"
                ? { pendingAttempt: null }
                : {}),
            },
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
      if (state.disposed) return;
      if (!state.releasing && !ownsWorker(engine, run.id, state))
        retireWorker(state);
      if (exit) {
        if (state.releasing) {
          state.dispose();
          return;
        }
        if (exit.interrupted && !state.stopStatus) state.stopStatus = "paused";
        state.stderr = exit.error || state.stderr;
        await engine.finish(run.id, state, exit.exitCode);
        state.dispose();
        return;
      }
      if (status.identity && status.identity !== run.worker.identity)
        throw new Error("Worker identity mismatch.");
      if (
        !state.idle &&
        !state.releasing &&
        !state.awaitingResume &&
        state.sawComplete &&
        (becameIdle || status.idle === true)
      ) {
        await engine.finish(run.id, state, 0, { keepAlive: true });
        return;
      }
      if (Date.now() - (status.time || run.worker.createdAt) > 10000) {
        if (status.pid) {
          try {
            process.kill(status.pid, 0);
            return;
          } catch (error) {
            if (error.code !== "ESRCH") return;
          }
        }
        if (state.releasing) {
          state.dispose();
          return;
        }
        state.stopStatus = "interrupted";
        const diagnostics = redact(
          await readFile(
            join(run.worker.directory, "worker.log"),
            "utf8",
          ).catch(() => ""),
        )
          .trim()
          .slice(-4000);
        state.stderr = [
          "Execution worker is unavailable. Resume explicitly; it has not been relaunched.",
          diagnostics ? `Worker diagnostics:\n${diagnostics}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        if (state.disposed || !ownsWorker(engine, run.id, state)) return;
        await engine.finish(run.id, state, null);
        state.dispose();
      }
    } catch (error) {
      state.stderr = error.message;
    }
  };
  state.poll = () => {
    if (state.disposed) return state.done;
    if (state.pending) return state.pending;
    state.pending = poll().finally(() => {
      state.pending = null;
      state.settle();
    });
    return state.pending;
  };
  state.poller = setInterval(state.poll, 250);
  state.poll();
  return state;
}
export async function resumeWorker(engine, run, prompt) {
  const state = engine.processes.get(run.id);
  // Finish the old poll/receipt before publishing a new command and capture
  // its latest committed cursor, not the run snapshot taken before context I/O.
  if (state?.durable && state.idle) await state.pending;
  if (
    engine.closing ||
    !state?.durable ||
    !state.idle ||
    state.releasing ||
    run.worker?.persistent !== true ||
    !ownsWorker(engine, run.id, state)
  )
    return false;
  run = { ...run, worker: engine.store.get("run", run.id).worker };
  const attempt = run.attempt + 1;
  state.idle = false;
  state.awaitingResume = true;
  state.started = Date.now();
  state.stderr = "";
  state.sawComplete = false;
  state.sawFailure = false;
  const worker = {
    ...run.worker,
    idle: false,
    model: run.model || "",
    turnCursor: run.worker.cursor,
    pendingAttempt: attempt,
  };
  engine.store.patch("run", run.id, {
    worker,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    attempt,
  });
  const temporary = join(run.worker.directory, `command-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        identity: run.worker.identity,
        attempt,
        prompt,
        run: { ...run, worker },
      }),
      { mode: 0o600 },
    );
    await rename(temporary, join(run.worker.directory, "command.json"));
    return true;
  } catch (error) {
    state.idle = true;
    state.awaitingResume = false;
    throw error;
  }
}
export async function stopWorker(run) {
  await writeFile(join(run.worker.directory, "stop"), "stop", { mode: 0o600 });
}
