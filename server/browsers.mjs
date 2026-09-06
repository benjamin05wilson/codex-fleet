import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { createBrowserProxy, browserURL } from "./browser-network.mjs";
import { redact } from "./sentinel.mjs";
const exec = promisify(execFile);
const reads = new Set(["snapshot", "screenshot", "tabs", "console", "network"]);
const keys = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Control+a",
  "Meta+a",
]);
export function browserCommand(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) =>
        ![
          "action",
          "target",
          "text",
          "url",
          "width",
          "height",
          "x",
          "y",
        ].includes(k),
    )
  )
    throw new Error("Invalid browser command.");
  const ref = () => {
    if (!/^@e\d+$/.test(input.target))
      throw new Error("Use an element reference from the latest snapshot.");
    return input.target;
  };
  const tab = () => {
    if (!/^t\d+$/.test(input.target))
      throw new Error("Use a tab ID from the tab list.");
    return input.target;
  };
  const text = () => {
    if (
      typeof input.text !== "string" ||
      input.text.length > 4000 ||
      input.text.includes("\0")
    )
      throw new Error("Text is limited to 4,000 characters.");
    return input.text;
  };
  switch (input.action) {
    case "snapshot":
      return ["snapshot"];
    case "console":
      return ["console"];
    case "network":
      return ["network", "requests"];
    case "tabs":
      return ["tab", "list"];
    case "navigate":
      return ["open", input.url];
    case "newTab":
      return ["tab", "new", input.url];
    case "selectTab":
      return ["tab", tab()];
    case "closeTab":
      throw new Error(
        "Individual tab closing is disabled: agent-browser 0.36.0 can reset other tabs. Use Close browser when finished.",
      );
    case "back":
    case "forward":
    case "reload":
      return [input.action];
    case "click":
      return ["click", ref()];
    case "fill":
      return ["fill", ref(), text()];
    case "type":
      return ["keyboard", "type", text()];
    case "press":
      if (!keys.has(input.text)) throw new Error("Unsupported browser key.");
      return ["press", input.text];
    case "scroll":
      if (!["up", "down", "left", "right"].includes(input.text))
        throw new Error("Invalid scroll direction.");
      return ["scroll", input.text, "400"];
    case "viewport":
      if (
        !Number.isInteger(input.width) ||
        !Number.isInteger(input.height) ||
        input.width < 320 ||
        input.width > 1920 ||
        input.height < 320 ||
        input.height > 1200
      )
        throw new Error("Invalid viewport size.");
      return ["set", "viewport", String(input.width), String(input.height)];
    case "screenshot":
      return null;
    default:
      throw new Error("Unsupported browser action.");
  }
}

export class Browsers {
  constructor(engine, { driver, proxyFactory = createBrowserProxy } = {}) {
    this.engine = engine;
    this.sessions = new Map();
    this.tokens = new Map();
    this.driver = driver;
    this.proxyFactory = proxyFactory;
    this.closing = false;
    this.bin =
      process.env.FLEET_BROWSER_BIN ||
      fileURLToPath(
        new URL(
          `../node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
          import.meta.url,
        ),
      );
    this.base = () => "";
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) {
        this.reconcile(s);
        if (Date.now() - s.touched > 30 * 60 * 1000)
          this.stop(s.projectId).catch(() => {});
      }
    }, 2000);
    this.timer.unref();
  }
  forbidden() {
    return [
      4317,
      Number(new URL(this.base() || "http://127.0.0.1:4317").port),
      ...Array.from(this.sessions.values())
        .flatMap((s) => [s.proxy?.port, s.streamPort])
        .filter(Boolean),
    ];
  }
  state(projectId, clientId) {
    this.engine.store.get("project", projectId);
    const s = this.sessions.get(projectId);
    if (!s)
      return {
        status: "closed",
        available: !!this.driver || existsSync(this.bin),
      };
    this.reconcile(s);
    return {
      status: s.status,
      url: s.url,
      origins: s.origins,
      width: s.width,
      height: s.height,
      controller: s.controller,
      canControl: s.controller === "human" && s.clientId === clientId,
      agentRunId: s.agentRunId || null,
      error: s.error || null,
      lastAction: s.lastAction || null,
      pending: s.pending
        ? {
            id: s.pending.id,
            action: s.pending.input.action,
            target: s.pending.input.target,
            url: s.pending.input.url,
            text:
              s.pending.input.action === "fill"
                ? "[text entry]"
                : s.pending.input.text,
          }
        : null,
    };
  }
  reconcile(s) {
    if (s.used && s.agentRunId) {
      const run = this.engine.store.get("run", s.agentRunId);
      if (run.status !== "running" || run.deletedAt) this.revoke(s);
    }
  }
  revoke(s) {
    s.epoch++;
    s.agentRunId = null;
    s.used = false;
    s.controller = "human";
    for (const [token, c] of this.tokens)
      if (c.projectId === s.projectId) this.tokens.delete(token);
    if (s.pending) {
      clearTimeout(s.pending.timer);
      s.pending.reject(new Error("Browser control was revoked."));
      s.pending = null;
    }
  }
  async command(s, args) {
    if (this.driver) return this.driver(s, args);
    const env = Object.fromEntries(
      ["HOME", "USER", "PATH", "TMPDIR"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    let stdout;
    try {
      ({ stdout } = await exec(
        this.bin,
        ["--session", s.name, "--config", s.config, "--json", ...args],
        {
          cwd: s.directory,
          env: {
            ...env,
            AGENT_BROWSER_DEFAULT_TIMEOUT: "10000",
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "1800000",
          },
          timeout: 15000,
          maxBuffer: 1500000,
        },
      ));
    } catch (error) {
      // The native CLI reports structured errors on stdout even for a nonzero exit.
      let detail;
      try {
        detail = JSON.parse(error.stdout).error;
      } catch {}
      throw new Error(
        typeof detail === "string"
          ? redact(detail)
          : "Browser command failed or timed out.",
      );
    }
    const result = JSON.parse(stdout);
    if (result.success === false)
      throw new Error(result.error || "Browser command failed.");
    return result.data;
  }
  async start(projectId, input, clientId) {
    this.engine.store.get("project", projectId);
    if (this.closing) throw new Error("Fleet is shutting down.");
    if (input.approved !== true)
      throw new Error("Approve opening a separate local browser.");
    if (this.sessions.has(projectId))
      throw new Error(
        "This project already has a browser. Close it before changing allowed sites.",
      );
    if (this.sessions.size >= 4)
      throw new Error("Close another project browser first (maximum four).");
    const url = browserURL(input.url, this.forbidden());
    if (
      !Array.isArray(input.origins || []) ||
      (input.origins || []).length > 12
    )
      throw new Error("Approve at most twelve additional origins.");
    const origins = [
      ...new Set([
        url.origin,
        ...(input.origins || []).map(
          (v) => browserURL(v, this.forbidden()).origin,
        ),
      ]),
    ];
    const directory = join(
      this.engine.dataDir,
      "browsers",
      projectId,
      randomUUID(),
    );
    const s = {
      projectId,
      directory,
      name: "fleet-" + randomUUID(),
      url: url.href,
      origins,
      controller: "human",
      clientId,
      status: "starting",
      width: 1280,
      height: 800,
      epoch: 0,
      queue: Promise.resolve(),
      queued: 0,
      touched: Date.now(),
    };
    this.sessions.set(projectId, s);
    s.starting = (async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        s.proxy = await this.proxyFactory(origins, this.forbidden());
        const policy = join(directory, "policy.json");
        s.config = join(directory, "agent-browser.json");
        await writeFile(
          policy,
          JSON.stringify({
            default: "allow",
            deny: ["eval", "download", "upload", "state"],
          }),
          { mode: 0o600 },
        );
        await writeFile(
          s.config,
          JSON.stringify({
            headless: true,
            engine: "chrome",
            allowedDomains: origins.map((v) => new URL(v).hostname),
            proxy: `http://127.0.0.1:${s.proxy.port}`,
            proxyBypass: "<-loopback>",
            args: "--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            actionPolicy: policy,
            maxOutput: 24000,
            contentBoundaries: true,
          }),
          { mode: 0o600 },
        );
        await this.command(s, ["open", url.href]);
        await this.command(s, ["set", "viewport", "1280", "800"]);
        const stream = await this.command(s, ["stream", "status"]);
        s.streamPort = stream?.port;
        if (!this.driver) {
          if (
            !Number.isInteger(s.streamPort) ||
            s.streamPort < 1024 ||
            s.streamPort > 65535
          )
            throw new Error("Browser stream is unavailable.");
          s.socket = new WebSocket(`ws://127.0.0.1:${s.streamPort}/?maxFps=8`);
          s.socket.onmessage = (e) => {
            if (String(e.data).length > 2000000) return;
            try {
              const v = JSON.parse(String(e.data));
              if (
                v.type === "frame" &&
                typeof v.data === "string" &&
                v.data.length < 1800000
              ) {
                s.frame = {
                  image: "data:image/jpeg;base64," + v.data,
                  seq: v.seq,
                  width: v.metadata.deviceWidth,
                  height: v.metadata.deviceHeight,
                  at: Date.now(),
                };
              }
              if (v.type === "url") {
                s.url = v.url;
                s.frame = null;
              }
            } catch {}
          };
          s.socket.onerror = () => {
            s.error =
              "Live view disconnected. Close and reopen the browser to reconnect.";
            s.frame = null;
          };
          s.socket.onclose = () => {
            if (s.status === "open") {
              s.error =
                "Live view disconnected. Close and reopen the browser to reconnect.";
              s.frame = null;
            }
          };
        }
        s.status = "open";
      } catch (e) {
        s.error = redact(e.message);
        await this.dispose(s);
        this.sessions.delete(projectId);
        throw new Error("Could not open the browser: " + s.error);
      }
    })();
    await s.starting;
    return this.state(projectId);
  }
  require(projectId) {
    const s = this.sessions.get(projectId);
    if (!s || s.status !== "open")
      throw new Error("Open the project browser first.");
    this.reconcile(s);
    return s;
  }
  human(s, clientId) {
    if (s.controller !== "human" || s.clientId !== clientId)
      throw new Error("Take control of the browser before interacting.");
  }
  take(projectId, clientId) {
    const s = this.require(projectId);
    this.revoke(s);
    s.clientId = clientId;
    return this.state(projectId);
  }
  grant(projectId, runId, clientId, approved) {
    const s = this.require(projectId);
    this.human(s, clientId);
    const run = this.engine.store.get("run", runId);
    if (
      !approved ||
      run.projectId !== projectId ||
      run.deletedAt ||
      run.sessionKind === "terminal" ||
      run.reviewOf ||
      (run.teamRole && run.teamRole !== "developer")
    )
      throw new Error(
        "Choose a coding chat in this project and explicitly share its browser.",
      );
    if (
      !["draft", "paused", "interrupted", "failed", "review"].includes(
        run.status,
      )
    )
      throw new Error(
        "Pause the chat before sharing. Browser tools attach on the next turn.",
      );
    this.revoke(s);
    s.agentRunId = runId;
    s.controller = "agent";
    return this.state(projectId);
  }
  connection(run, identity) {
    const s = this.sessions.get(run.projectId);
    if (!s || s.status !== "open" || s.agentRunId !== run.id) return null;
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, {
      projectId: run.projectId,
      runId: run.id,
      identity,
      epoch: s.epoch,
    });
    s.used = true;
    return {
      url: this.base() + "/api/browser-agent",
      token,
      node: process.execPath,
      script: fileURLToPath(new URL("./browser-mcp.mjs", import.meta.url)),
    };
  }
  async agent(token, input) {
    const c = this.tokens.get(token);
    if (!c)
      throw Object.assign(new Error("Browser access expired or was revoked."), {
        status: 403,
      });
    const s = this.require(c.projectId),
      run = this.engine.store.get("run", c.runId);
    if (
      s.agentRunId !== run.id ||
      s.epoch !== c.epoch ||
      run.status !== "running" ||
      run.deletedAt ||
      run.worker?.identity !== c.identity
    )
      throw new Error("This attempt no longer controls the browser.");
    if (["type", "viewport", "clickPoint"].includes(input?.action))
      throw new Error("Action is not available to agents.");
    browserCommand(input);
    if (!reads.has(input.action)) {
      if (s.pending)
        throw new Error("A browser action is already waiting for approval.");
      await new Promise((resolve, reject) => {
        const pending = { id: randomUUID(), input, resolve, reject };
        pending.timer = setTimeout(() => {
          if (s.pending === pending) s.pending = null;
          reject(new Error("Browser action approval timed out."));
        }, 60000);
        s.pending = pending;
      });
    }
    return this.execute(s, input, () => {
      if (
        s.epoch !== c.epoch ||
        s.agentRunId !== c.runId ||
        this.engine.store.get("run", c.runId).status !== "running" ||
        this.engine.store.get("run", c.runId).worker?.identity !== c.identity
      )
        throw new Error("Browser control was revoked.");
    });
  }
  approve(projectId, input, clientId) {
    const s = this.require(projectId);
    if (s.clientId !== clientId)
      throw new Error(
        "Only the sharing browser window can approve this action.",
      );
    const p = s.pending;
    if (!p || p.id !== input.id) throw new Error("This approval has expired.");
    s.pending = null;
    clearTimeout(p.timer);
    input.approved === true
      ? p.resolve()
      : p.reject(new Error("User denied the browser action."));
    return this.state(projectId);
  }
  async control(projectId, input, clientId) {
    const s = this.require(projectId);
    this.human(s, clientId);
    const epoch = s.epoch;
    return this.execute(s, input, () => {
      this.human(s, clientId);
      if (s.epoch !== epoch) throw new Error("Browser ownership changed.");
    });
  }
  async execute(s, input, check) {
    if (s.queued >= 24) throw new Error("Browser input queue is full.");
    s.queued++;
    const task = s.queue
      .catch(() => {})
      .then(async () => {
        check();
        if (s.status !== "open") throw new Error("Browser is closed.");
        s.touched = Date.now();
        let result;
        if (input.action === "clickPoint") {
          if (
            !Number.isFinite(input.x) ||
            !Number.isFinite(input.y) ||
            input.x < 0 ||
            input.y < 0 ||
            input.x > s.width ||
            input.y > s.height
          )
            throw new Error("Invalid pointer position.");
          await this.command(s, [
            "mouse",
            "move",
            String(Math.round(input.x)),
            String(Math.round(input.y)),
          ]);
          check();
          await this.command(s, ["mouse", "down", "left"]);
          await this.command(s, ["mouse", "up", "left"]);
          result = { ok: true };
        } else {
          const args = browserCommand(input);
          if (input.action === "newTab") {
            const current = await this.command(s, ["tab", "list"]);
            if (current.tabs?.length >= 12)
              throw new Error(
                "Tab limit reached. Reuse a tab or close and reopen the browser.",
              );
          }
          if (["navigate", "newTab"].includes(input.action)) {
            const u = browserURL(input.url, this.forbidden());
            if (!s.origins.includes(u.origin))
              throw new Error(
                "Close and reopen the browser to approve this origin.",
              );
          }
          if (input.action === "screenshot") {
            const path = join(s.directory, "capture-" + randomUUID() + ".png");
            try {
              await this.command(s, ["screenshot", path]);
              const bytes = await readFile(path);
              if (bytes.length > 1500000)
                throw new Error(
                  "Screenshot is too large. Use a smaller viewport.",
                );
              result = { image: bytes.toString("base64") };
            } finally {
              await unlink(path).catch(() => {});
            }
          } else result = await this.command(s, args);
        }
        if (input.action === "viewport") {
          s.width = input.width;
          s.height = input.height;
          s.frame = null;
        }
        s.lastAction = input.action;
        if (!reads.has(input.action)) {
          const current = await this.command(s, ["get", "url"]);
          s.url = typeof current === "string" ? current : current?.url || s.url;
        }
        return result?.image
          ? result
          : {
              output: redact(
                typeof result === "string" ? result : JSON.stringify(result),
              ).slice(0, 24000),
            };
      })
      .finally(() => s.queued--);
    s.queue = task;
    return task;
  }
  frame(projectId) {
    const s = this.require(projectId);
    s.touched = Date.now();
    return s.frame || { image: null };
  }
  async tabs(projectId) {
    const s = this.require(projectId);
    const result = await this.execute(s, { action: "tabs" }, () => {});
    return (JSON.parse(result.output).tabs || []).slice(0, 32).map((tab) => ({
      id: tab.tabId,
      title: tab.title || tab.url || "New tab",
      url: tab.url,
      active: tab.active,
    }));
  }
  async dispose(s) {
    s.status = "closing";
    this.revoke(s);
    await s.queue.catch(() => {});
    s.socket?.close();
    s.frame = null;
    await this.command(s, ["close"]).catch(() => {});
    await s.proxy?.close();
  }
  async stop(projectId) {
    const s = this.sessions.get(projectId);
    if (!s) return { status: "closed" };
    if (s.stopping) return s.stopping;
    s.stopping = (async () => {
      await s.starting?.catch(() => {});
      await this.dispose(s);
      this.sessions.delete(projectId);
      return { status: "closed" };
    })();
    return s.stopping;
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
