import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { createBrowserProxy, browserURL } from "./browser-network.mjs";
import { redact } from "./sentinel.mjs";
import { launchOwnedChrome, ownedChromeAvailable } from "./owned-chrome.mjs";
import {
  foregroundPid,
  backgroundChrome,
  ownedBrowserPid,
} from "./browser-focus.mjs";
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
          "deltaX",
          "deltaY",
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
    case "wheel":
      if (
        ![input.deltaX, input.deltaY].every(
          (v) => Number.isFinite(v) && Math.abs(v) <= 1500,
        )
      )
        throw new Error("Invalid wheel delta.");
      return null;
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
  constructor(
    engine,
    {
      driver,
      proxyFactory = createBrowserProxy,
      nativeLauncher = launchOwnedChrome,
      // Internal benchmark switch; never supplied by the renderer or agent.
      legacyFrames = false,
    } = {},
  ) {
    this.engine = engine;
    this.sessions = new Map();
    this.tokens = new Map();
    this.driver = driver;
    this.proxyFactory = proxyFactory;
    this.nativeLauncher = nativeLauncher;
    this.legacyFrames = legacyFrames;
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
    this.timer = setInterval(() => this.expireIdle().catch(() => {}), 2000);
    this.timer.unref();
  }
  async expireIdle(at = Date.now()) {
    for (const s of this.sessions.values()) {
      this.reconcile(s);
      if (!s.keepOpen && at - s.touched > 30 * 60 * 1000)
        await this.stop(s.projectId);
    }
  }
  forbidden() {
    return [
      4317,
      Number(new URL(this.base() || "http://127.0.0.1:4317").port),
      ...Array.from(this.sessions.values())
        .flatMap((s) => [
          s.proxy?.port,
          s.streamPort,
          s.native?.port,
          s.native?.gatePort,
          s.debugPort,
        ])
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
        attachedAvailable: !!this.driver || ownedChromeAvailable(),
      };
    this.reconcile(s);
    return {
      status: s.status,
      url: s.url,
      domainFiltering: false,
      mode: s.mode,
      background: !!s.native?.background,
      preciseWheel: true,
      keepOpen: s.keepOpen,
      width: s.width,
      height: s.height,
      controller: s.controller,
      canControl: s.controller === "human" && s.clientId === clientId,
      agentRunId: s.agentRunId || null,
      error: s.error || null,
      lastAction: s.lastAction || null,
      focusWarning: s.focusWarning || null,
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
      if (run.deletedAt) this.revoke(s);
      else if (run.status !== "running") {
        // The user's grant survives chat turns; attempt credentials never do.
        const runId = s.agentRunId;
        this.revoke(s);
        s.agentRunId = runId;
        s.controller = "agent";
      }
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
    this.notifyState(s);
  }
  notifyState(s) {
    for (const listener of s.frameListeners) listener({ refresh: true });
  }
  async command(s, args) {
    if (s.native && !s.native.alive() && args[0] !== "close")
      throw new Error(
        "The attached Chrome window has closed. Close this browser in Fleet before reopening.",
      );
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
            AGENT_BROWSER_IDLE_TIMEOUT_MS: s.keepOpen ? "0" : "1800000",
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
  async keepBackground(s, previous) {
    if (s.native?.background) return;
    if (this.driver || process.platform !== "darwin" || s.mode === "headless")
      return;
    try {
      if (!s.chromePid) {
        const value =
          s.native?.endpoint || (await this.command(s, ["get", "cdp-url"]));
        const endpoint =
          typeof value === "string" ? value : value?.cdpUrl || value?.url;
        s.debugPort = Number(new URL(endpoint).port);
        s.chromePid = await ownedBrowserPid(endpoint);
      }
      await backgroundChrome(s.chromePid, previous);
      s.focusWarning = null;
    } catch {
      s.focusWarning =
        "Chrome focus could not be restored. Switch back to Fleet to keep browsing here.";
    }
  }
  async start(projectId, input, clientId) {
    this.engine.store.get("project", projectId);
    if (this.closing) throw new Error("Fleet is shutting down.");
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (k) =>
          ![
            "url",
            "origins",
            "approved",
            "mode",
            "keepOpen",
            "experimentalApproved",
          ].includes(k),
      )
    )
      throw new Error("Unsupported browser launch settings.");
    const mode = input.mode ?? "visible";
    if (!["visible", "headless", "attached"].includes(mode))
      throw new Error(
        "Choose visible Chrome, headless or experimental attachment.",
      );
    if (mode === "attached" && input.experimentalApproved !== true)
      throw new Error(
        "Explicitly acknowledge the experimental attachment security limits first.",
      );
    if (input.keepOpen !== undefined && typeof input.keepOpen !== "boolean")
      throw new Error("Keep-open must be a boolean.");
    if (input.approved !== true)
      throw new Error("Approve opening a separate local browser.");
    if (this.sessions.has(projectId))
      throw new Error(
        "This project already has a browser. Close it before opening another.",
      );
    if (this.sessions.size >= 4)
      throw new Error("Close another project browser first (maximum four).");
    const url = browserURL(input.url, this.forbidden());
    // Legacy origins input is ignored, including requests for extra local access.
    const localOrigins = ["localhost", "127.0.0.1", "[::1]"].includes(
      url.hostname,
    )
      ? [url.origin]
      : [];
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
      localOrigins,
      mode,
      keepOpen: input.keepOpen === true,
      controller: "human",
      clientId,
      status: "starting",
      width: 1280,
      height: 800,
      epoch: 0,
      queue: Promise.resolve(),
      queued: 0,
      frameListeners: new Set(),
      touched: Date.now(),
    };
    this.sessions.set(projectId, s);
    s.starting = (async () => {
      const previous =
        !this.driver && mode !== "headless" && process.platform !== "darwin"
          ? await foregroundPid().catch(() => null)
          : null;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        s.proxy = await this.proxyFactory(localOrigins, this.forbidden());
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
        if (
          mode === "attached" ||
          (mode === "visible" && process.platform === "darwin" && !this.driver)
        ) {
          s.native = await this.nativeLauncher({
            background: true,
            directory,
            proxyPort: s.proxy.port,
            excludedPorts: [
              ...this.forbidden(),
              Number(url.port || (url.protocol === "https:" ? 443 : 80)),
            ],
            onExit: () => {
              if (s.status === "open") {
                s.status = "failed";
                s.error =
                  "The attached Chrome process closed. Close this browser in Fleet before reopening.";
                s.frame = null;
                this.revoke(s);
              }
            },
          });
        }
        await writeFile(
          s.config,
          JSON.stringify({
            engine: "chrome",
            restoreSave: "never",
            ...(s.native
              ? {
                  cdp: s.native.endpoint,
                  pinTab: !s.native.background,
                }
              : {
                  headed: mode === "visible",
                  proxy: `http://127.0.0.1:${s.proxy.port}`,
                  proxyBypass: "<-loopback>",
                  args: "--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--disable-renderer-backgrounding",
                }),
            actionPolicy: policy,
            maxOutput: 24000,
            contentBoundaries: true,
          }),
          { mode: 0o600 },
        );
        await this.command(s, ["open", url.href]);
        await this.keepBackground(s, previous);
        await this.command(s, ["set", "viewport", "1280", "800"]);
        if (s.native?.pages) {
          const { tabs } = await this.command(s, ["tab", "list"]);
          const target = tabs?.find((tab) => tab.active)?.targetId;
          if (!target) throw new Error("Active Chrome target unavailable.");
          await s.native.pages.bind(target, s.width, s.height);
        }
        const stream = await this.command(s, ["stream", "status"]);
        s.streamPort = stream?.port;
        if (s.native?.pages?.startFrames && !this.legacyFrames) {
          await s.native.pages.startFrames(
            (v) => {
              if (s.status === "closing") return;
              s.frame = {
                image: "data:image/jpeg;base64," + v.data,
                seq: v.seq,
                width: v.metadata.deviceWidth,
                height: v.metadata.deviceHeight,
                capturedAt: v.metadata.timestamp * 1000,
                scrollY: v.metadata.scrollOffsetY,
                at: Date.now(),
              };
              for (const listener of s.frameListeners) listener(s.frame);
            },
            () => {
              if (s.status === "open") {
                s.error =
                  "Live Chrome connection closed. Close and reopen the project browser.";
                s.frame = null;
                for (const listener of s.frameListeners)
                  listener({ image: null });
                this.notifyState(s);
              }
            },
            ({ url, clear }) => {
              if (url) s.url = url;
              if (clear) {
                s.frame = null;
                for (const listener of s.frameListeners)
                  listener({ image: null });
              }
            },
          );
        } else if (!this.driver) {
          if (
            !Number.isInteger(s.streamPort) ||
            s.streamPort < 1024 ||
            s.streamPort > 65535
          )
            throw new Error("Browser stream is unavailable.");
          s.socket = new WebSocket(`ws://127.0.0.1:${s.streamPort}/?maxFps=60`);
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
                for (const listener of s.frameListeners) listener(s.frame);
              }
              if (v.type === "url") {
                s.url = v.url;
                s.frame = null;
                for (const listener of s.frameListeners)
                  listener({ image: null });
              }
            } catch {}
          };
          s.socket.onerror = () => {
            s.error =
              "Live view disconnected. Close and reopen the browser to reconnect.";
            s.frame = null;
            for (const listener of s.frameListeners) listener({ image: null });
            this.notifyState(s);
          };
          s.socket.onclose = () => {
            if (s.status === "open") {
              s.error =
                "Live view disconnected. Close and reopen the browser to reconnect.";
              s.frame = null;
              for (const listener of s.frameListeners)
                listener({ image: null });
              this.notifyState(s);
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
    return this.state(projectId, clientId);
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
    this.notifyState(s);
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
    if (["type", "viewport", "clickPoint", "wheel"].includes(input?.action))
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
        this.notifyState(s);
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
    this.notifyState(s);
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
        const changesFocus = ["navigate", "newTab", "selectTab"].includes(
          input.action,
        );
        const previous =
          changesFocus &&
          !s.native?.background &&
          !this.driver &&
          s.mode !== "headless"
            ? await foregroundPid().catch(() => null)
            : null;
        try {
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
            if (s.native?.pages)
              result = await s.native.pages.input(input, s.width, s.height);
            else {
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
            }
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
              if (
                ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
                !s.localOrigins.includes(u.origin)
              )
                throw new Error(
                  "Only the selected local preview is accessible.",
                );
            }
            if (
              s.native?.pages &&
              ["type", "wheel", "press"].includes(input.action)
            ) {
              result = await s.native.pages.input(input, s.width, s.height);
            } else if (input.action === "wheel") {
              for (const [delta, negative, positive] of [
                [input.deltaX, "left", "right"],
                [input.deltaY, "up", "down"],
              ]) {
                if (Math.abs(delta) < 0.5) continue;
                check();
                result = await this.command(s, [
                  "scroll",
                  delta < 0 ? negative : positive,
                  String(Math.round(Math.abs(delta))),
                ]);
              }
              result ||= { ok: true };
            } else if (input.action === "screenshot") {
              const path = join(
                s.directory,
                "capture-" + randomUUID() + ".png",
              );
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
          if (
            s.native?.pages &&
            ["newTab", "selectTab", "viewport"].includes(input.action)
          ) {
            const { tabs } = await this.command(s, ["tab", "list"]);
            const target = tabs?.find((tab) => tab.active)?.targetId;
            if (!target) throw new Error("Active Chrome target unavailable.");
            await s.native.pages.bind(target, s.width, s.height);
          }
          s.lastAction = input.action;
          if (
            [
              "navigate",
              "newTab",
              "selectTab",
              "back",
              "forward",
              "reload",
              "click",
              "press",
            ].includes(input.action)
          ) {
            const current = s.native?.pages
              ? await s.native.pages.url()
              : await this.command(s, ["get", "url"]);
            s.url =
              typeof current === "string" ? current : current?.url || s.url;
          }
          return result?.image
            ? result
            : {
                output: redact(
                  typeof result === "string" ? result : JSON.stringify(result),
                ).slice(0, 24000),
              };
        } finally {
          if (changesFocus) await this.keepBackground(s, previous);
        }
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
  streamFrames(projectId, res) {
    const s = this.require(projectId);
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    let blocked = false,
      pendingFrame,
      pendingRefresh = false,
      closed = false;
    const flush = () => {
      if (blocked || closed || res.destroyed) return;
      if (pendingRefresh) {
        pendingRefresh = false;
        blocked = !res.write(JSON.stringify({ refresh: true }) + "\n");
      }
      if (!blocked && pendingFrame !== undefined) {
        const frame = pendingFrame;
        // write(false) means accepted into Node's buffer, not rejected. Clear
        // the pending frame BEFORE writing so drain never replays it forever.
        pendingFrame = undefined;
        blocked = !res.write(JSON.stringify(frame) + "\n");
      }
    };
    const send = (frame) => {
      if (frame === null) return res.end();
      if (closed || res.destroyed) return;
      if (frame.refresh) pendingRefresh = true;
      else pendingFrame = frame;
      flush();
    };
    const drain = () => {
      blocked = false;
      flush();
    };
    res.on("drain", drain);
    s.frameListeners.add(send);
    send(s.frame || { image: null });
    const timer = setInterval(() => {
      s.touched = Date.now();
      if (!blocked) blocked = !res.write("\n");
    }, 10000);
    const close = () => {
      closed = true;
      pendingFrame = undefined;
      pendingRefresh = false;
      clearInterval(timer);
      s.frameListeners.delete(send);
      res.off("drain", drain);
    };
    res.once("close", close);
    res.once("finish", close);
  }
  async tabs(projectId) {
    const s = this.require(projectId);
    const result = await this.execute(s, { action: "tabs" }, () => {});
    const tabs = JSON.parse(result.output).tabs || [];
    const active = tabs.find((tab) => tab.active);
    if (active?.url) s.url = active.url;
    return tabs.slice(0, 32).map((tab) => ({
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
    for (const listener of s.frameListeners) listener(null);
    s.frameListeners.clear();
    s.frame = null;
    await this.command(s, ["close"]).catch(() => {});
    try {
      await s.native?.close();
    } finally {
      await s.proxy?.close();
    }
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
