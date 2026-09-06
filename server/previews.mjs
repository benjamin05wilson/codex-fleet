import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { request } from "node:http";
import { ACTIVE } from "./engine.mjs";
import { redact } from "./sentinel.mjs";

export function previewPort(value, forbidden = []) {
  const port = Number(value);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    forbidden.includes(port)
  )
    throw new Error(
      "Choose an unprivileged preview port, different from Fleet’s port.",
    );
  return port;
}
async function available(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(new Error("Preview port is already in use.")),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
async function responds(port) {
  return new Promise((resolve) => {
    const req = request(
      { hostname: "127.0.0.1", port, path: "/", method: "HEAD", timeout: 800 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}
export class Previews {
  constructor(engine) {
    this.engine = engine;
    this.sessions = new Map();
    this.opening = new Set();
    for (const run of engine.store.list("run"))
      if (["starting", "running", "stopping"].includes(run.preview?.status))
        engine.store.patch("run", run.id, {
          preview: { ...run.preview, status: "interrupted", url: null },
        });
  }
  has(worktree) {
    return (
      this.opening.has(worktree) ||
      [...this.sessions.values()].some((s) => s.worktree === worktree)
    );
  }
  async start(run, input, forbidden = []) {
    if (input.approved !== true)
      throw new Error(
        "Approve local preview execution first. This command is not sandboxed.",
      );
    if (
      !run.worktree ||
      [...ACTIVE, "queued", "accepted"].includes(run.status) ||
      (run.teamRole && run.teamRole !== "developer")
    )
      throw new Error(
        "Preview needs a stopped, unaccepted implementation worktree.",
      );
    const command = input.command?.trim();
    if (!command || command.length > 2000)
      throw new Error("Enter a preview command (up to 2,000 characters).");
    const port = previewPort(input.port, forbidden);
    this.engine.assertIdleWorktree(run, { allowTeamReaders: false });
    this.opening.add(run.worktree);
    try {
      await available(port);
      if ([...this.sessions.values()].some((s) => s.port === port))
        throw new Error("This preview port is reserved by another session.");
      this.opening.delete(run.worktree);
      this.engine.assertIdleWorktree(run, { allowTeamReaders: false });
      if (
        [...ACTIVE, "queued", "accepted"].includes(
          this.engine.store.get("run", run.id).status,
        )
      )
        throw new Error(
          "Session changed while preparing preview. Try again after it stops.",
        );
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./runner.mjs", import.meta.url))],
        {
          cwd: run.worktree,
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      const session = {
        child,
        worktree: run.worktree,
        port,
        output: "",
        probing: false,
      };
      this.sessions.set(run.id, session);
      const patch = (value) =>
        this.engine.store.patch("run", run.id, {
          preview: {
            ...this.engine.store.get("run", run.id).preview,
            ...value,
          },
        });
      this.engine.store.patch("run", run.id, {
        validation: null,
        preview: {
          status: "starting",
          command: redact(command),
          port,
          url: null,
          output: "",
          startedAt: new Date().toISOString(),
        },
      });
      this.engine.store.event(run.projectId, run.id, "preview.started", {
        command: redact(command),
        port,
        sandboxed: false,
      });
      const append = (chunk) => {
        session.output = redact(session.output + chunk.toString()).slice(
          -20000,
        );
        patch({ output: session.output });
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (e) => append(e.message));
      session.done = new Promise((resolve) =>
        child.once("close", (code) => {
          clearInterval(session.poll);
          clearTimeout(session.timeout);
          clearTimeout(session.killTimer);
          // A supervisor can exit before a background descendant. Terminate only
          // this owned process group before releasing the worktree lease.
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          this.sessions.delete(run.id);
          patch({
            status: session.stopping ? "stopped" : "exited",
            exitCode: code,
            url: null,
          });
          this.engine.store.event(run.projectId, run.id, "preview.stopped", {
            exitCode: code,
          });
          resolve();
        }),
      );
      session.poll = setInterval(async () => {
        if (session.probing || session.stopping) return;
        session.probing = true;
        const ready = await responds(port);
        session.probing = false;
        if (this.sessions.get(run.id) === session && !session.stopping)
          patch({
            status: ready ? "running" : "starting",
            url: ready ? `http://127.0.0.1:${port}/` : null,
          });
      }, 1500);
      session.timeout = setTimeout(() => this.stop(run.id), 15 * 60000);
      child.send({
        bin: "/bin/zsh",
        args: ["-f", "-c", command],
        cwd: run.worktree,
      });
      return this.engine.store.get("run", run.id).preview;
    } finally {
      this.opening.delete(run.worktree);
    }
  }
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) return { status: "stopped" };
    if (!session.stopping) {
      session.stopping = true;
      const run = this.engine.store.get("run", id);
      this.engine.store.patch("run", id, {
        preview: { ...run.preview, status: "stopping", url: null },
      });
      try {
        process.kill(-session.child.pid, "SIGTERM");
      } catch {}
      session.killTimer = setTimeout(() => {
        try {
          process.kill(-session.child.pid, "SIGKILL");
        } catch {}
      }, 2500);
    }
    await session.done;
    return { status: "stopped" };
  }
  async close() {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
