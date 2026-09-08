import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateNativeAction } from "../shared/native-browser-actions.mjs";

const failure = (message) => Object.assign(new Error(message), { status: 409 });
export class NativeBrowserBroker {
  constructor(engine) {
    this.engine = engine;
    this.sessions = new Map();
    this.desktopTokens = new Map();
    this.tokens = new Map();
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
  desktop(token) {
    const session = this.desktopTokens.get(token);
    if (!session)
      throw Object.assign(new Error("Native browser connection expired."), {
        status: 403,
      });
    return session;
  }
  touch(session) {
    clearTimeout(session.lease);
    session.lease = setTimeout(() => this.disconnect(session.token), 40000);
    session.lease.unref?.();
  }
  disconnect(token) {
    const s = this.desktopTokens.get(token);
    if (!s) return {};
    clearTimeout(s.lease);
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
        c.runId === run.id ||
        !owner ||
        owner.deletedAt ||
        (owner.status !== "running" &&
          !(owner.status === "review" && owner.worker?.persistent === true)) ||
        owner.worker?.identity !== c.identity
      )
        this.tokens.delete(token);
    }
    const token = randomBytes(32).toString("hex");
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
  check(token) {
    const c = this.tokens.get(token),
      run = c && this.engine.store.get("run", c.runId);
    if (
      !run ||
      run.deletedAt ||
      run.projectId !== c.projectId ||
      run.status !== "running" ||
      run.worker?.identity !== c.identity
    )
      throw Object.assign(
        new Error("Browser access for this chat turn has expired."),
        { status: 403 },
      );
    return c;
  }
  async agent(token, input) {
    const c = this.check(token);
    validateNativeAction(input);
    // Only a navigation request can create a page. References/actions from a
    // closed page must fail, never silently operate on a replacement page.
    if (input.action === "navigate" && this.launcher) {
      await this.enqueue(this.launcher, token, {
        projectId: c.projectId,
        runId: c.runId,
        url: input.url,
      });
      this.check(token);
    }
    const s = this.sessions.get(c.projectId);
    if (!s)
      throw failure(
        this.launcher
          ? "This project has no open page. Use navigate with a URL to open its shared browser automatically."
          : "Fleet Desktop is not connected to the browser opener. Open or restart Fleet Desktop, then retry navigate; no Browser-panel click is needed.",
      );
    return this.enqueue(s, token, input);
  }
  enqueue(s, token, input) {
    if (s.queue.length >= 16)
      throw failure(
        "Browser queue is full. Wait for existing actions to finish.",
      );
    return new Promise((resolve, reject) => {
      const task = { id: randomUUID(), input, token, resolve, reject };
      s.queue.push(task);
      this.drain(s);
    });
  }
  drain(s) {
    if (!s.waiter || s.current) return;
    while (s.queue.length) {
      const task = s.queue.shift();
      try {
        this.check(task.token);
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
    this.touch(s);
    if (s.waiter) throw failure("Native command receiver already connected.");
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (s.waiter?.finish === finish) s.waiter = null;
        resolve(value);
      };
      const abort = () => finish(null);
      const timer = setTimeout(() => finish(null), 25000);
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
    s.current = null;
    try {
      this.check(task.token);
      if (error) task.reject(failure(String(error).slice(0, 500)));
      else task.resolve(result);
    } catch (e) {
      task.reject(e);
    }
    this.drain(s);
    return {};
  }
  async close() {
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
