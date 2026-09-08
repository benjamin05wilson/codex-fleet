import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { ACTIVE } from "./engine.mjs";
import { processEnvironment, terminalCommand } from "../shared/platform.mjs";
export class Terminals {
  constructor(engine, { loadPty = () => import("node-pty") } = {}) {
    this.engine = engine;
    this.loadPty = loadPty;
    this.sessions = new Map();
    this.opening = new Set();
    this.pendingOpens = new Set();
    this.closing = false;
  }
  has(worktree) {
    return (
      this.opening.has(worktree) ||
      [...this.sessions.values()].some(
        (s) => s.worktree === worktree && s.exitCode === undefined,
      )
    );
  }
  open(run, owner) {
    if (this.closing || this.engine.closing)
      return Promise.reject(new Error("Terminal service is shutting down."));
    const pending = this.openSession(run, owner);
    this.pendingOpens.add(pending);
    const settled = () => this.pendingOpens.delete(pending);
    pending.then(settled, settled);
    return pending;
  }
  async openSession(run, owner) {
    if (run.teamRole && run.teamRole !== "developer")
      throw new Error("Team reviewer sessions cannot open a writable shell.");
    const existing = this.sessions.get(run.id);
    if (existing) {
      if (existing.closing)
        throw new Error(
          "The shell is closing; wait for it to exit before handing over.",
        );
      if (existing.owner !== owner)
        throw new Error(
          "This shell is controlled by another client. Close it there before handing over.",
        );
      return { lease: existing.lease };
    }
    this.engine.assertIdleWorktree(run, { allowTeamReaders: false });
    if (!run.worktree || [...ACTIVE, "queued", "accepted"].includes(run.status))
      throw new Error("A stopped, unaccepted worktree is required.");
    this.opening.add(run.worktree);
    try {
      const pty = await this.loadPty();
      if (this.closing || this.engine.closing)
        throw new Error("Terminal service is shutting down.");
      const env = processEnvironment();
      delete env.CODEX_HOME;
      const command = terminalCommand();
      const shell = pty.spawn(command.bin, command.args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: run.worktree,
        env: { ...env, TERM: "xterm-256color" },
      });
      const session = {
        process: shell,
        owner,
        lease: randomUUID(),
        worktree: run.worktree,
        events: [],
        seq: 0,
        subscriptions: [],
      };
      let resolveExit;
      session.exited = new Promise((resolve) => {
        resolveExit = resolve;
      });
      this.sessions.set(run.id, session);
      session.subscriptions.push(
        shell.onData((data) => {
          session.events.push({ seq: ++session.seq, data });
          session.bytes = (session.bytes || 0) + Buffer.byteLength(data);
          while (session.bytes > 2_000_000 && session.events.length > 1)
            session.bytes -= Buffer.byteLength(session.events.shift().data);
          if (session.events.length > 5000)
            session.events.splice(0, session.events.length - 5000);
        }),
      );
      session.subscriptions.push(
        shell.onExit(({ exitCode }) => {
          session.exitCode = exitCode;
          clearTimeout(session.killTimer);
          try {
            this.engine.store.patch("run", run.id, {
              shellOpen: false,
              validation: null,
            });
            this.engine.store.event(run.projectId, run.id, "terminal.exited", {
              exitCode,
            });
          } catch (error) {
            session.exitError = error;
          } finally {
            for (const subscription of session.subscriptions)
              subscription.dispose();
            if (session.closing && this.sessions.get(run.id) === session)
              this.sessions.delete(run.id);
            resolveExit();
          }
        }),
      );
      this.engine.store.patch("run", run.id, {
        validation: null,
        shellOpen: true,
      });
      this.engine.store.event(run.projectId, run.id, "terminal.opened", {
        sandboxed: false,
      });
      return { lease: session.lease };
    } finally {
      this.opening.delete(run.worktree);
    }
  }
  get(runId) {
    const session = this.sessions.get(runId);
    if (!session) throw new Error("No shell is open for this session.");
    return session;
  }
  control(runId, lease, action, input) {
    const s = this.get(runId);
    if (s.lease !== lease)
      throw new Error("This client does not own the terminal controls.");
    if (action !== "close" && (this.closing || s.closing))
      throw new Error("The shell is closing; wait for it to exit.");
    if (action === "input") {
      if (typeof input.data !== "string" || input.data.length > 16384)
        throw new Error("Invalid terminal input.");
      s.process.write(input.data);
    } else if (action === "resize") {
      if (
        !Number.isInteger(input.cols) ||
        !Number.isInteger(input.rows) ||
        input.cols < 2 ||
        input.cols > 500 ||
        input.rows < 1 ||
        input.rows > 200
      )
        throw new Error("Invalid terminal dimensions.");
      s.process.resize(input.cols, input.rows);
    } else if (action === "close") {
      s.closing = true;
      if (s.exitCode !== undefined) this.sessions.delete(runId);
      else this.terminate(s);
    }
    return { ok: true };
  }
  terminate(session) {
    if (session.terminationRequested || session.exitCode !== undefined) return;
    if (process.platform === "win32") {
      // node-pty's ConPTY kill path uses a short-lived AttachConsole helper to
      // find descendants. When Fleet itself has a console, Windows may reject
      // that helper's attachment even though ConPTY still closes correctly.
      // Keep the supported node-pty cleanup path, but prevent that best-effort
      // helper from dumping an uncaught native error into Fleet's own logs.
      const fork = childProcess.fork;
      childProcess.fork = (modulePath, args, options = {}) =>
        fork(modulePath, args, {
          ...options,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      try {
        session.process.kill();
      } finally {
        childProcess.fork = fork;
      }
    } else {
      session.process.kill();
      // A shell may trap SIGHUP; shutdown must still wait for a real exit,
      // escalating the signal instead of disposing its database callbacks early.
      if (session.exitCode === undefined)
        session.killTimer = setTimeout(() => {
          try {
            session.process.kill("SIGKILL");
          } catch {}
        }, 3500);
    }
    session.terminationRequested = true;
  }
  close() {
    if (this.closePending) return this.closePending;
    this.closing = true;
    this.closePending = this.drain();
    return this.closePending;
  }
  async drain() {
    // An import already in progress must settle before shutdown can promise
    // that no new session (and no new SQLite callback) can appear.
    await Promise.allSettled([...this.pendingOpens]);
    const results = await Promise.allSettled(
      [...this.sessions].map(async ([key, session]) => {
        session.closing = true;
        this.terminate(session);
        await session.exited;
        if (this.sessions.get(key) === session) this.sessions.delete(key);
        if (session.exitError) throw session.exitError;
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
