import { randomUUID } from "node:crypto";
import { ACTIVE } from "./engine.mjs";
export class Terminals {
  constructor(engine) {
    this.engine = engine;
    this.sessions = new Map();
    this.opening = new Set();
  }
  has(worktree) {
    return (
      this.opening.has(worktree) ||
      [...this.sessions.values()].some(
        (s) => s.worktree === worktree && s.exitCode === undefined,
      )
    );
  }
  async open(run, owner) {
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
      const pty = await import("node-pty");
      const env = Object.fromEntries(
        ["PATH", "HOME", "USER", "TMPDIR", "LANG"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]]),
      );
      const shell = pty.spawn("/bin/zsh", ["-f"], {
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
      };
      this.sessions.set(run.id, session);
      this.engine.store.patch("run", run.id, {
        validation: null,
        shellOpen: true,
      });
      this.engine.store.event(run.projectId, run.id, "terminal.opened", {
        sandboxed: false,
      });
      shell.onData((data) => {
        session.events.push({ seq: ++session.seq, data });
        session.bytes = (session.bytes || 0) + Buffer.byteLength(data);
        while (session.bytes > 2_000_000 && session.events.length > 1)
          session.bytes -= Buffer.byteLength(session.events.shift().data);
        if (session.events.length > 5000)
          session.events.splice(0, session.events.length - 5000);
      });
      shell.onExit(({ exitCode }) => {
        session.exitCode = exitCode;
        if (session.closing) this.sessions.delete(run.id);
        this.engine.store.patch("run", run.id, {
          shellOpen: false,
          validation: null,
        });
        this.engine.store.event(run.projectId, run.id, "terminal.exited", {
          exitCode,
        });
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
      s.process.kill();
    }
    return { ok: true };
  }
  close() {
    for (const s of this.sessions.values()) s.process.kill();
    this.sessions.clear();
  }
}
