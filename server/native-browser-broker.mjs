import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inside } from "./git.mjs";
import { validateNativeAction } from "../shared/native-browser-actions.mjs";

const failure = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const cancelled = (signal) =>
  signal.reason?.status === 504
    ? signal.reason
    : failure(
        "Browser request cancelled. An in-flight action may have completed; inspect the page before retrying.",
        499,
      );
export class NativeBrowserBroker {
  constructor(
    engine,
    {
      commandTimeoutMs = 80000,
      transportTimeoutMs = 60000,
      pollTimeoutMs = 25000,
    } = {},
  ) {
    this.engine = engine;
    this.commandTimeoutMs = commandTimeoutMs;
    this.transportTimeoutMs = transportTimeoutMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.sessions = new Map();
    this.desktopTokens = new Map();
    this.tokens = new Map();
    this.onChange = ({ kind }) => {
      if (kind !== "run") return;
      for (const s of this.desktopTokens.values()) {
        for (const task of [s.current, ...s.queue].filter(Boolean)) {
          try {
            this.check(task.token, task.attempt);
          } catch (error) {
            task.reject(error);
          }
        }
      }
    };
    engine.store.changes?.on("change", this.onChange);
    // Durable workers keep their MCP connection across backend restarts.
    // Recover only credentials belonging to the currently attached worker.
    if (engine.dataDir) {
      for (const run of engine.store.list("run")) {
        if (
          !this.eligible(run) ||
          !run.worker?.directory ||
          !inside(join(engine.dataDir, "workers", run.id), run.worker.directory)
        )
          continue;
        try {
          const config = JSON.parse(
            readFileSync(join(run.worker.directory, "config.json"), "utf8"),
          );
          if (
            config.identity === run.worker.identity &&
            config.run?.id === run.id &&
            config.run?.projectId === run.projectId &&
            /^[a-f0-9]{64}$/.test(config.browser?.token || "")
          ) {
            this.tokens.set(config.browser.token, {
              projectId: run.projectId,
              runId: run.id,
              identity: config.identity,
            });
          }
        } catch {
          /* A missing worker config is handled by worker recovery. */
        }
      }
    }
  }
  eligible(run) {
    return Boolean(
      run &&
      !run.deletedAt &&
      run.projectId &&
      !run.reviewOf &&
      run.kind !== "review" &&
      (!run.teamRole || run.teamRole === "developer") &&
      (run.status === "running" ||
        (run.worker?.persistent === true &&
          ["queued", "preparing", "review"].includes(run.status))),
    );
  }
  state(projectId) {
    return {
      status: this.sessions.has(projectId) ? "open" : "closed",
      mode: "native",
      available: true,
      desktopOnly: true,
      agentAvailable: true,
      controller: "shared",
      approvalRequired: false,
    };
  }
  register({ projectId, nativeId }) {
    if (
      !this.engine.store.get("project", projectId) ||
      typeof nativeId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(nativeId)
    )
      throw failure("Choose an existing project browser.");
    const previous = this.sessions.get(projectId);
    if (previous && previous.nativeId !== nativeId)
      throw failure(
        "This project already has a browser in another Fleet window. Close that browser first.",
      );
    if (previous) this.disconnect(previous.token);
    const token = randomBytes(32).toString("hex");
    const session = {
      projectId,
      nativeId,
      token,
      queue: [],
      current: null,
      waiter: null,
    };
    this.sessions.set(projectId, session);
    this.desktopTokens.set(token, session);
    this.touch(session);
    return { token };
  }
  registerLauncher({ nativeId }) {
    if (typeof nativeId !== "string" || !/^[a-f0-9-]{36}$/.test(nativeId))
      throw failure("Invalid Fleet desktop identity.");
    if (this.launcher && this.launcher.nativeId !== nativeId)
      throw failure("Another Fleet desktop is already connected.");
    if (this.launcher) this.disconnect(this.launcher.token);
    const token = randomBytes(32).toString("hex");
    this.launcher = { nativeId, token, queue: [], current: null, waiter: null };
    this.desktopTokens.set(token, this.launcher);
    this.touch(this.launcher);
    return { token };
  }
  // This lease measures transport traffic, never page age or chat activity.
  // The desktop continues polling while idle and while executing a command.
  touch(s) {
    clearTimeout(s.transportTimer);
    s.transportTimer = setTimeout(
      () => this.disconnect(s.token),
      this.transportTimeoutMs,
    );
    s.transportTimer.unref?.();
  }
  desktop(token) {
    const session = this.desktopTokens.get(token);
    if (!session)
      throw Object.assign(new Error("Native browser connection expired."), {
        status: 403,
      });
    return session;
  }
  disconnect(token) {
    const s = this.desktopTokens.get(token);
    if (!s) return {};
    clearTimeout(s.transportTimer);
    this.desktopTokens.delete(token);
    if (this.launcher === s) this.launcher = null;
    if (this.sessions.get(s.projectId) === s) this.sessions.delete(s.projectId);
    s.waiter?.finish(null);
    for (const task of [s.current, ...s.queue].filter(Boolean)) {
      task.reject(
        failure(
          "Native browser disconnected. An in-flight action may have completed; inspect the page before retrying.",
        ),
      );
    }
    s.queue.length = 0;
    s.current = null;
    return {};
  }
  connection(run, identity) {
    if (
      !run.projectId ||
      run.deletedAt ||
      run.kind === "review" ||
      (run.teamRole && run.teamRole !== "developer")
    )
      return null;
    for (const [token, c] of this.tokens) {
      const owner = this.engine.store.get("run", c.runId);
      if (
        !owner ||
        owner.deletedAt ||
        !this.eligible(owner) ||
        owner.worker?.identity !== c.identity
      )
        this.tokens.delete(token);
    }
    const existing = [...this.tokens].find(
      ([, c]) => c.runId === run.id && c.identity === identity,
    );
    const token = existing?.[0] || randomBytes(32).toString("hex");
    this.tokens.set(token, {
      projectId: run.projectId,
      runId: run.id,
      identity,
    });
    return {
      url: this.base() + "/api/browser-agent",
      token,
      node: process.execPath,
      script: fileURLToPath(new URL("./browser-mcp.mjs", import.meta.url)),
    };
  }
  check(token, attempt) {
    const c = this.tokens.get(token),
      run = c && this.engine.store.get("run", c.runId);
    if (
      !this.eligible(run) ||
      run.status !== "running" ||
      run.worker?.idle === true ||
      (attempt !== undefined && run.attempt !== attempt) ||
      run.projectId !== c.projectId ||
      run.worker?.identity !== c.identity
    )
      throw Object.assign(
        new Error(
          "This browser connection belongs to a stopped or replaced chat worker. Resume the chat to reconnect.",
        ),
        { status: 403 },
      );
    return c;
  }
  async agent(token, input, signal) {
    const c = this.check(token);
    validateNativeAction(input);
    const attempt = this.engine.store.get("run", c.runId).attempt;
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          failure(
            "Browser request timed out. An in-flight action may have completed; inspect the page before retrying.",
            504,
          ),
        ),
      this.commandTimeoutMs,
    );
    const scope = {
      attempt,
      signal: signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal,
    };
    try {
      // Only a navigation request can create a page. References/actions from a
      // closed page must fail, never silently operate on a replacement page.
      if (
        this.launcher &&
        (input.action === "navigate" || this.sessions.has(c.projectId))
      ) {
        await this.enqueue(
          this.launcher,
          token,
          {
            projectId: c.projectId,
            runId: c.runId,
            ...(input.action === "navigate" ? { url: input.url } : {}),
          },
          scope,
        );
        this.check(token, attempt);
      }
      const s = this.sessions.get(c.projectId);
      if (!s)
        throw failure(
          this.launcher
            ? "This project has no open page. Use navigate with a URL to open its shared browser automatically."
            : "Fleet Desktop is not connected to the browser opener. Open or restart Fleet Desktop, then retry navigate; no Browser-panel click is needed.",
        );
      return await this.enqueue(s, token, input, scope);
    } finally {
      clearTimeout(timer);
    }
  }
  enqueue(s, token, input, { signal, attempt }) {
    if (signal.aborted) throw cancelled(signal);
    if (s.queue.length >= 16)
      throw failure(
        "Browser queue is full. Wait for existing actions to finish.",
      );
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        const index = s.queue.indexOf(task);
        if (index !== -1) s.queue.splice(index, 1);
        // Keep a dispatched command as the serialization barrier until its
        // result arrives. Cancellation cannot undo a native page operation.
        callback(value);
      };
      const task = {
        id: randomUUID(),
        input,
        token,
        attempt,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      const abort = () => task.reject(cancelled(signal));
      signal.addEventListener("abort", abort, { once: true });
      s.queue.push(task);
      this.drain(s);
    });
  }
  drain(s) {
    if (!s.waiter || s.current) return;
    while (s.queue.length) {
      const task = s.queue.shift();
      try {
        this.check(task.token, task.attempt);
      } catch (e) {
        task.reject(e);
        continue;
      }
      s.current = task;
      s.waiter.finish({ id: task.id, input: task.input });
      return;
    }
  }
  next(token, signal) {
    const s = this.desktop(token);
    if (s.waiter) throw failure("Native command receiver already connected.");
    if (signal.aborted) return Promise.resolve(null);
    this.touch(s);
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (s.waiter?.finish === finish) s.waiter = null;
        resolve(value);
      };
      const abort = () => finish(null);
      const timer = setTimeout(() => finish(null), this.pollTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      s.waiter = { finish };
      this.drain(s);
    });
  }
  result(token, { id, result, error }) {
    const s = this.desktop(token),
      task = s.current;
    if (!task || task.id !== id)
      throw failure("Browser result no longer belongs to an active command.");
    this.touch(s);
    s.current = null;
    try {
      this.check(task.token, task.attempt);
      if (error) task.reject(failure(String(error).slice(0, 500)));
      else task.resolve(result);
    } catch (e) {
      task.reject(e);
    }
    this.drain(s);
    return {};
  }
  async close() {
    this.engine.store.changes?.off("change", this.onChange);
    for (const token of [...this.desktopTokens.keys()]) this.disconnect(token);
    this.tokens.clear();
  }
  unavailable() {
    throw Object.assign(
      new Error(
        "Only the shared native desktop browser is supported. No alternate browser will be launched.",
      ),
      { status: 410 },
    );
  }
  start() {
    return this.unavailable();
  }
  control() {
    return this.unavailable();
  }
  grant() {
    return this.unavailable();
  }
  take() {
    return this.unavailable();
  }
  approve() {
    return this.unavailable();
  }
  frame() {
    return this.unavailable();
  }
  streamFrames() {
    return this.unavailable();
  }
  tabs() {
    return this.unavailable();
  }
  stop(projectId) {
    return this.state(projectId);
  }
}
