import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { watch, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  unlink,
  realpath,
} from "node:fs/promises";
import { id, now } from "./store.mjs";
import { validatePermissions } from "../shared/permissions.mjs";
import { limits } from "./limits.mjs";
import {
  launchWorker,
  attachWorker,
  resumeWorker,
  stopWorker,
  retireWorker,
  ownsWorker,
} from "./durable.mjs";
import { sandboxCheck } from "./codex-client.mjs";
import { isAuthenticationError, signInMessage } from "../shared/auth.mjs";
import { shellCommand, stopProcessTree } from "../shared/platform.mjs";
import { git, changes, snapshot, createWorktree, inside } from "./git.mjs";
import {
  redact,
  redactValue,
  scanCommand,
  scanChanges,
  fingerprint,
} from "./sentinel.mjs";

export const ACTIVE = [
  "preparing",
  "running",
  "pausing",
  "validating",
  "accepting",
];
export function scopesOverlap(a = [], b = []) {
  if (!a.length || !b.length || a.includes(".") || b.includes(".")) return true;
  return a.some((x) =>
    b.some((y) => {
      x = x.replace(/\/$/, "");
      y = y.replace(/\/$/, "");
      return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
    }),
  );
}
export function codexArgs(run) {
  validatePermissions(run);
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_mode="${run.sandbox}"`,
    "-c",
    "sandbox_workspace_write.network_access=false",
  ];
  if (run.model) args.push("-m", run.model);
  if (run.threadId) args.push("resume", run.threadId, "-");
  else args.push("-");
  return args;
}

export class Engine {
  constructor(
    store,
    brain,
    dataDir,
    {
      bin = process.env.FLEET_CODEX_BIN || "codex",
      concurrency = 3,
      transport = "app-server",
    } = {},
  ) {
    this.store = store;
    this.brain = brain;
    this.dataDir = dataDir;
    this.bin = bin;
    this.transport = transport;
    this.concurrency = concurrency;
    this.processes = new Map();
    this.workers = new Set();
    this.finishes = new Set();
    this.validations = new Map();
    this.watchers = new Map();
    this.scanDebounce = new Map();
    this.scans = new Set();
    this.busy = false;
    this.closing = false;
    const removedProjects = new Set(
      store
        .list("project")
        .filter((project) => project.removedAt)
        .map((project) => project.id),
    );
    for (const run of store.list("run"))
      if (!run.deletedAt && !removedProjects.has(run.projectId)) {
        if (
          run.worker &&
          (["running", "pausing"].includes(run.status) ||
            (run.status === "review" && run.worker.persistent === true))
        ) {
          attachWorker(this, run);
          continue;
        }
        if (!ACTIVE.includes(run.status) && run.status !== "queued") continue;
        store.patch("run", run.id, {
          status: "interrupted",
          error:
            "Fleet restarted. Resume explicitly to continue in the preserved worktree.",
        });
        store.event(run.projectId, run.id, "run.interrupted", {
          reason: "daemon restart",
        });
      }
    this.timer = setInterval(() => this.tick().catch(() => {}), 800);
    this.scanTimer = setInterval(() => this.scanActive(), 4000);
    for (const run of store.list("run")) {
      if (run.deletedAt || removedProjects.has(run.projectId)) continue;
      if (run.worktree) this.watchWorktree(run);
      if (run.shellOpen) {
        store.patch("run", run.id, { shellOpen: false, validation: null });
        store.event(run.projectId, run.id, "terminal.interrupted", {
          reason: "daemon restart",
        });
      }
    }
  }
  create(projectId, input) {
    const project = this.store.get("project", projectId);
    if (project.removedAt)
      throw new Error("Open this project folder again before creating a chat.");
    if (!input.title?.trim() || !input.prompt?.trim())
      throw new Error("A title and task are required.");
    if (input.title.length > 160 || input.prompt.length > 30_000)
      throw new Error("Task is too long.");
    const sandbox = validatePermissions(input);
    if (
      sandbox === "danger-full-access" &&
      (input.workflowId || input.missionId)
    )
      throw new Error("YOLO is only available for independent chats.");
    const dependencies = input.dependencies || [];
    if (!Array.isArray(dependencies)) throw new Error("Invalid dependencies.");
    for (const key of dependencies) {
      const parent = this.store.get("run", key);
      if (parent.deletedAt)
        throw new Error("Restore a deleted dependency before using it.");
      if (parent.projectId !== projectId)
        throw new Error("Dependencies must belong to this project.");
    }
    const scopes = (input.scopes || [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (scopes.some((s) => s.startsWith("/") || s.includes("..")))
      throw new Error("Scope paths must be relative to the repository.");
    return this.store.put("run", {
      id: id(),
      projectId,
      missionId: input.missionId || null,
      workflowId: input.workflowId || null,
      contextOptions: input.contextOptions || {},
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      initialPrompt: input.prompt.trim(),
      sandbox,
      ...(sandbox === "danger-full-access" ? { yoloApproved: true } : {}),
      model: String(input.model || "").trim(),
      scopes,
      dependencies,
      status: "draft",
      createdAt: now(),
      updatedAt: now(),
      files: [],
      summary: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      durationMs: 0,
      attempt: 0,
    });
  }
  queue(key, followup, { teamManaged = false } = {}) {
    let run = this.store.get("run", key);
    if (this.store.get("project", run.projectId).removedAt)
      throw new Error("Open this project folder again before continuing.");
    if (run.sessionKind === "terminal")
      throw new Error("This is a terminal, not a Codex conversation.");
    if (run.waitingForTask) {
      if (
        typeof followup !== "string" ||
        !followup.trim() ||
        followup.length > 30000
      )
        throw new Error("Give this conversation its first instruction.");
    }
    if (run.teamInitial && !teamManaged)
      throw new Error(
        "Assign a new task through the project team, or request another assessment.",
      );
    if (run.teamRole && run.teamRole !== "developer" && !teamManaged)
      throw new Error(
        "Reviewers are read-only team sessions. Request a team review instead of assigning arbitrary work.",
      );
    if (run.workflowId) {
      const workflow = this.store.get("workflow", run.workflowId);
      if (!workflow.approvedAt)
        throw new Error("Approve the workflow before starting its tasks.");
      if (workflow.reason)
        throw new Error(
          workflow.reason + " Approve a revised plan to continue.",
        );
      if (run.attempt >= 2)
        throw new Error(
          "This plan has exhausted its approved retry limit. Create and approve a revised plan.",
        );
    }
    this.assertIdleWorktree(run);
    if (
      !["draft", "paused", "interrupted", "failed", "review"].includes(
        run.status,
      )
    )
      throw new Error("This session cannot be queued in its current state.");
    if (run.status === "review" && !followup?.trim())
      throw new Error("Add a follow-up instruction to continue this session.");
    this.store.patch("run", key, {
      ...(run.waitingForTask
        ? {
            waitingForTask: false,
            prompt: followup.trim(),
            initialPrompt: followup.trim(),
            title: followup.trim().split("\n")[0].slice(0, 100),
          }
        : {}),
      status: "queued",
      followup: followup?.trim() || null,
      error: null,
      validation: null,
    });
    this.store.event(run.projectId, key, "run.queued", {
      prompt: followup?.trim() || null,
      ...(run.waitingForTask ? { initialInstruction: true } : {}),
      source: teamManaged ? "team" : "user",
    });
    this.tick().catch(() => {});
    return this.store.get("run", key);
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.busy = true;
    try {
      for (const run of this.store
        .list("run")
        .reverse()
        .filter(
          (r) =>
            !r.deletedAt &&
            r.status === "queued" &&
            !this.store.get("project", r.projectId).removedAt,
        )) {
        if (this.closing) break;
        // A previous launch yields: Trash or Pause may have changed another
        // entry in this queue snapshot while it was being prepared.
        const current = this.store.get("run", run.id);
        if (current.deletedAt || current.status !== "queued") continue;
        if (this.processes.get(run.id)?.releasing) continue;
        if (
          [...this.processes.values()].filter((state) => !state.idle).length >=
          this.concurrency
        )
          break;
        const conflict = this.store
          .list("run")
          .find(
            (other) =>
              other.id !== run.id &&
              other.projectId === run.projectId &&
              ACTIVE.includes(other.status) &&
              other.sandbox !== "read-only" &&
              run.sandbox !== "read-only" &&
              scopesOverlap(run.scopes, other.scopes),
          );
        if (conflict) {
          if (
            run.blockedReason !==
            `Waiting for ${conflict.title}: overlapping file scope.`
          )
            this.store.patch("run", run.id, {
              blockedReason: `Waiting for ${conflict.title}: overlapping file scope.`,
            });
          continue;
        }
        if (
          !run.dependencies.every((d) => {
            const dep = this.store.get("run", d);
            if (dep.deletedAt) return false;
            return (
              dep.status === "accepted" ||
              (run.workflowId &&
                dep.workflowId === run.workflowId &&
                dep.status === "review" &&
                (dep.sandbox === "read-only" ||
                  dep.validation?.status === "passed"))
            );
          })
        )
          continue;
        this.store.patch("run", run.id, {
          status: "preparing",
          blockedReason: null,
        });
        try {
          await this.launch(run.id);
        } catch (e) {
          this.store.patch("run", run.id, {
            status:
              e.code === "CODEX_SIGN_IN_REQUIRED" ? "interrupted" : "failed",
            error: redact(e.message),
          });
          this.store.event(run.projectId, run.id, "run.failed", {
            message: redact(e.message),
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async launch(key) {
    await this.auth?.requireReady();
    let run = this.store.get("run", key);
    if (run.sessionKind === "terminal")
      throw new Error("Terminal sessions cannot launch Codex.");
    this.assertIdleWorktree(run);
    const project = this.store.get("project", run.projectId);
    if (!run.worktree) {
      run = this.store.patch(
        "run",
        key,
        await createWorktree(project, run, this.dataDir),
      );
      for (const dep of run.dependencies) {
        const parent = this.store.get("run", dep);
        if (parent.acceptedSha)
          await git(run.worktree, [
            "-c",
            "user.name=Fleet",
            "-c",
            "user.email=fleet@localhost",
            "merge",
            "--no-edit",
            parent.acceptedSha,
          ]);
        else if (run.workflowId && parent.validation?.status === "passed") {
          if ((await snapshot(parent)) !== parent.validation.snapshot)
            throw new Error(
              "Dependency checks are stale. Recheck its worktree before continuing.",
            );
          for (const file of (await changes(parent)).files) {
            const source = resolve(parent.worktree, file),
              target = resolve(run.worktree, file);
            if (
              !inside(parent.worktree, source) ||
              !inside(run.worktree, target)
            )
              throw new Error("Invalid dependency file.");
            const stat = await lstat(source).catch(() => null);
            if (stat?.isSymbolicLink())
              throw new Error(
                "Review symbolic-link changes manually before continuing dependencies.",
              );
            if (!stat)
              await unlink(target).catch((error) => {
                if (error.code !== "ENOENT") throw error;
              });
            else if (stat.isFile()) {
              if (
                !inside(await realpath(parent.worktree), await realpath(source))
              )
                throw new Error("Dependency path escapes its worktree.");
              await mkdir(dirname(target), { recursive: true });
              if (
                !inside(
                  await realpath(run.worktree),
                  await realpath(dirname(target)),
                )
              )
                throw new Error("Dependency target escapes its worktree.");
              const existing = await lstat(target).catch(() => null);
              if (existing?.isSymbolicLink())
                throw new Error("Dependency target is a symbolic link.");
              await writeFile(target, await readFile(source), {
                mode: stat.mode,
              });
            }
          }
          if ((await snapshot(parent)) !== parent.validation.snapshot)
            throw new Error(
              "Dependency changed during handoff; review before retrying.",
            );
        }
      }
      run = this.store.patch("run", key, {
        base: (await git(run.worktree, ["rev-parse", "HEAD"])).trim(),
      });
    }
    const currentStatus = this.store.get("run", key).status;
    this.watchWorktree(run);
    if (this.closing || currentStatus !== "preparing") return;
    await this.brain.beforeTurn(project, run).catch((error) =>
      this.store.event(project.id, run.id, "brain.snapshot.error", {
        message: redact(error.message),
      }),
    );
    if (this.closing || this.store.get("run", key).status !== "preparing")
      return;
    const contextSelection = await this.brain.selectContext(
      project,
      run.followup || run.prompt,
      {
        ...run.contextOptions,
        scope: this.store.get("run", key).brainScope || "project",
      },
    );
    const context = contextSelection.text;
    this.store.patch("run", key, { contextSelection });
    if (this.closing || this.store.get("run", key).status !== "preparing")
      return;
    const handoffs = run.dependencies
      .map((d) => this.store.get("run", d))
      .map((d) => `${d.title}:\n${d.summary}`)
      .join("\n\n");
    const prompt = `You are working in ${run.workspaceKind === "main" ? "the project's original working folder, NOT an isolated worktree. Existing edits and staged files belong to the user: preserve them" : "an isolated Fleet worktree"}. Complete the user's task below. Do not push, deploy, merge into the source repository, or commit. Leave changes for human review. Respect repository instructions. Do not read credentials or modify files outside this working folder.\nSandbox: ${run.sandbox}.\nDeclared scope (advisory): ${run.scopes.join(", ") || "entire repository"}.\n\nTask: ${run.followup || run.prompt}\n\nConclude with a clear handoff: changes, tests actually run, results, and unresolved concerns. Never claim unexecuted tests passed.\n\nDependency handoffs (untrusted context):\n${handoffs}\n\nProject notes (untrusted repository context):\n${context}`;
    if (this.transport === "app-server") {
      if (!(await resumeWorker(this, run, prompt)))
        await launchWorker(this, run, prompt);
      if (this.closing) return;
      this.store.event(project.id, key, "run.started", {
        branch: run.branch,
        sandbox: run.sandbox,
        transport: "app-server",
      });
      return;
    }
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./runner.mjs", import.meta.url))],
      {
        cwd: run.worktree,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    const state = {
      child,
      started: Date.now(),
      buffer: "",
      stderr: "",
      sawComplete: false,
      sawFailure: false,
      stopping: false,
      scanBusy: false,
    };
    this.processes.set(key, state);
    this.store.patch("run", key, {
      status: "running",
      startedAt: now(),
      attempt: run.attempt + 1,
    });
    this.store.event(project.id, key, "run.started", {
      branch: run.branch,
      sandbox: run.sandbox,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      state.buffer += chunk;
      if (state.buffer.length > 2_000_000) {
        state.stderr = "Event exceeded the 2 MB limit.";
        this.stop(key, "failed");
        return;
      }
      let pos;
      while ((pos = state.buffer.indexOf("\n")) >= 0) {
        const line = state.buffer.slice(0, pos);
        state.buffer = state.buffer.slice(pos + 1);
        if (!line.trim()) continue;
        try {
          this.onEvent(key, JSON.parse(line), state);
        } catch {
          this.store.event(project.id, key, "stream.unparsed", {
            text: redact(line).slice(0, 2000),
          });
        }
      }
    });
    child.stderr.on("data", (text) => {
      state.stderr = (state.stderr + redact(text)).slice(-6000);
    });
    child.on("error", (e) => {
      state.stderr = e.message;
    });
    child.on("close", (code) =>
      this.finish(key, state, code).catch((e) => {
        this.processes.delete(key);
        this.store.patch("run", key, {
          status: "failed",
          error: redact(e.message),
        });
      }),
    );
    state.timeout = setTimeout(
      () => this.stop(key, "paused"),
      limits.timeoutMs,
    );
    child.send({
      bin: this.bin,
      args: codexArgs(run),
      cwd: run.worktree,
      prompt,
    });
  }
  onEvent(key, raw, state) {
    if (state.durable && !ownsWorker(this, key, state)) return;
    const run = this.store.get("run", key);
    const event = redactValue(raw);
    if (
      ["turn.failed", "error"].includes(event.type) &&
      isAuthenticationError(event.error?.message || event.message)
    ) {
      this.auth?.invalidate();
      state.stopStatus = "interrupted";
      state.stderr = signInMessage;
      event.error = { message: signInMessage };
      if (event.message) event.message = signInMessage;
    }
    this.store.event(run.projectId, key, event.type || "codex.event", event);
    if (event.type === "thread.started")
      this.store.patch("run", key, { threadId: event.thread_id });
    if (event.type === "item.completed" && event.item?.type === "agent_message")
      this.store.patch("run", key, { summary: event.item.text || "" });
    if (event.type === "turn.completed") {
      state.sawComplete = true;
      const usage = { ...run.usage };
      for (const field of [
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
      ])
        usage[field] = (usage[field] || 0) + (event.usage?.[field] || 0);
      this.store.patch("run", key, { usage });
    }
    if (["turn.failed", "error"].includes(event.type)) state.sawFailure = true;
    if (event.item?.command) {
      const finding = scanCommand(event.item.command);
      if (finding) this.finding(run, finding);
    }
  }
  finding(run, finding) {
    const key = `${run.id}-${fingerprint(finding)}`;
    try {
      const existing = this.store.get("finding", key);
      if (existing.state === "resolved")
        this.store.patch("finding", key, {
          state: "suspected",
          reopenedAt: now(),
        });
      return;
    } catch {}
    this.store.put("finding", {
      ...finding,
      id: key,
      runId: run.id,
      projectId: run.projectId,
      createdAt: now(),
    });
    this.store.event(run.projectId, run.id, "sentinel.finding", {
      title: finding.title,
      severity: finding.severity,
      path: finding.path,
    });
  }
  scan(key) {
    const pending = this.scanWorktree(key);
    this.scans.add(pending);
    pending.then(
      () => this.scans.delete(pending),
      () => this.scans.delete(pending),
    );
    return pending;
  }
  async scanWorktree(key) {
    const run = this.store.get("run", key);
    if (run.deletedAt) return { files: [], diff: "" };
    const change = await changes(run);
    this.store.patch("run", key, { files: change.files });
    const coverage = {};
    const detected = await scanChanges(run, change.files, coverage);
    coverage.skipped.push(...change.files.slice(300));
    const digest = await snapshot(run);
    if (
      run.validation?.status === "passed" &&
      run.validation.snapshot !== digest
    )
      this.store.patch("run", key, {
        validation: { ...run.validation, status: "stale" },
      });
    const active = new Set(detected.map((f) => `${run.id}-${fingerprint(f)}`));
    for (const f of this.store
      .list("finding")
      .filter(
        (f) =>
          f.runId === key &&
          f.rule !== "command" &&
          f.state === "suspected" &&
          !active.has(f.id) &&
          (!change.files.includes(f.path) || coverage.checked.includes(f.path)),
      )) {
      this.store.patch("finding", f.id, {
        state: "resolved",
        resolvedAt: now(),
        resolvedSnapshot: digest,
      });
      this.store.event(run.projectId, key, "sentinel.fixed", {
        id: f.id,
        snapshot: digest,
      });
    }
    for (const finding of detected) this.finding(run, finding);
    if (run.workflowId && detected.some((f) => f.rule === "scope")) {
      this.store.patch("workflow", run.workflowId, {
        status: "needs-attention",
        reason: "A task changed files outside its approved scope.",
      });
      if (this.processes.has(key)) this.stop(key, "paused");
      else if (run.status === "review")
        this.store.patch("run", key, {
          status: "paused",
          error: "Scope changed. Approve a revised plan before continuing.",
        });
    }
    this.store.patch("run", key, {
      scan: {
        status: coverage.skipped.length ? "partial" : "completed",
        snapshot: digest,
        files: change.files.length,
        checkedAt: now(),
        coverage: "targeted-heuristics",
        skipped: coverage.skipped,
      },
    });
    return { ...change, diff: redact(change.diff) };
  }
  async scanActive() {
    if (this.closing) return;
    const candidates = new Map(this.processes);
    for (const run of this.store
      .list("run")
      .filter(
        (r) =>
          !r.deletedAt &&
          r.worktree &&
          ["review", "paused", "failed"].includes(r.status),
      ))
      if (!candidates.has(run.id)) candidates.set(run.id, { scanBusy: false });
    for (const [key, state] of candidates)
      if (!state.scanBusy) {
        state.scanBusy = true;
        this.scan(key)
          .catch(() => {})
          .finally(() => {
            state.scanBusy = false;
          });
      }
  }
  watchWorktree(run) {
    if (
      this.closing ||
      run.deletedAt ||
      this.watchers.has(run.id) ||
      !run.worktree
    )
      return;
    try {
      const watcher = watch(
        // libuv's Windows watcher can abort the entire process for 8.3 aliases
        // or mixed separators. Resolve the native long path at this boundary.
        realpathSync.native(run.worktree),
        { recursive: true },
        (_event, filename) => {
          if (
            this.closing ||
            /(?:^|\/)(?:\.git|\.fleet|node_modules|dist|vendor)(?:\/|$)/.test(
              filename || "",
            )
          )
            return;
          clearTimeout(this.scanDebounce.get(run.id));
          this.scanDebounce.set(
            run.id,
            setTimeout(() => {
              this.scanDebounce.delete(run.id);
              if (!this.closing)
                this.scan(run.id).catch((error) => {
                  if (!this.closing)
                    this.store.event(run.projectId, run.id, "scan.error", {
                      message: redact(error.message),
                    });
                });
            }, 400),
          );
        },
      );
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(run.id);
      });
      this.watchers.set(run.id, watcher);
    } catch {
      /* Periodic reconciliation remains available when native watching is unavailable. */
    }
  }
  finish(key, state, code, options = {}) {
    if (state.finishing) return state.finishing;
    const pending = this.finishTurn(key, state, code, options);
    state.finishing = pending;
    this.finishes.add(pending);
    const settled = () => {
      this.finishes.delete(pending);
      state.finishing = null;
      if (!options.keepAlive && this.processes.get(key) === state)
        this.processes.delete(key);
    };
    pending.then(settled, settled);
    return pending;
  }
  async finishTurn(key, state, code, { keepAlive = false } = {}) {
    if (state.durable && !ownsWorker(this, key, state)) return;
    clearTimeout(state.timeout);
    clearTimeout(state.killTimer);
    const run = this.store.get("run", key);
    if (isAuthenticationError(state.stderr)) {
      this.auth?.invalidate();
      state.stderr = signInMessage;
      state.stopStatus = "interrupted";
    }
    const status =
      state.stopStatus ||
      (code === 0 && state.sawComplete && !state.sawFailure
        ? "review"
        : "failed");
    const completion = {
      durationMs: run.durationMs + Date.now() - state.started,
      error: ["failed", "interrupted"].includes(status)
        ? state.stderr ||
          "Codex did not complete a turn. Inspect the event stream."
        : null,
      finishedAt: now(),
    };
    await this.scan(key).catch((e) =>
      this.store.event(run.projectId, key, "scan.error", {
        message: e.message,
      }),
    );
    if (state.durable && !ownsWorker(this, key, state)) return;
    const blocked =
      run.workflowId &&
      this.store.get("workflow", run.workflowId).status === "needs-attention";
    let finalStatus =
      state.stopStatus || (blocked && status === "review" ? "paused" : status);
    // Snapshot this turn before exposing an idle session: a follow-up must not
    // start writing into the previous turn's end snapshot.
    await this.brain.receipt(this.store.get("project", run.projectId), {
      ...this.store.get("run", key),
      ...completion,
      status: finalStatus,
    });
    if (state.durable && !ownsWorker(this, key, state)) return;
    finalStatus = state.stopStatus || finalStatus;
    if (keepAlive && finalStatus === "review") {
      state.idle = true;
      state.awaitingResume = false;
      state.stopStatus = null;
      state.stderr = "";
      state.sawComplete = false;
      state.sawFailure = false;
    }
    const latest = this.store.patch("run", key, {
      // Commit accounting together with the final status, after the scan and
      // ownership check. A detached poller leaves no partial duration to replay.
      ...completion,
      status: finalStatus,
      ...(keepAlive && finalStatus === "review"
        ? { worker: { ...run.worker, idle: true, persistent: true } }
        : {}),
    });
    if (keepAlive && finalStatus !== "review") {
      state.idle = true;
      this.releaseIdleWorker(key);
    }
    this.store.event(run.projectId, key, `run.${status}`, { exitCode: code });
    this.tick().catch(() => {});
  }
  releaseIdleWorker(key) {
    const state = this.processes.get(key);
    if (!state?.durable || !state.idle) return false;
    if (state.releasing) return true;
    const run = this.store.get("run", key);
    if (ownsWorker(this, key, state))
      this.store.patch("run", key, {
        worker: { ...run.worker, idle: false, persistent: false },
      });
    retireWorker(state);
    return true;
  }
  stop(key, status = "paused") {
    const run = this.store.get("run", key);
    const state = this.processes.get(key);
    if (state?.durable) {
      state.stopStatus = status;
      this.store.patch("run", key, { status: "pausing" });
      if (state.stopPending) return this.store.get("run", key);
      state.stopPending = stopWorker({ worker: state.worker })
        .catch((error) => {
          if (ownsWorker(this, key, state))
            this.store.patch("run", key, { error: error.message });
        })
        .finally(() => {
          state.stopPending = null;
          state.settle();
        });
      return this.store.get("run", key);
    }
    if (!state) {
      if (["queued", "draft", "preparing"].includes(run.status))
        return this.store.patch("run", key, { status });
      throw new Error("This session is not running.");
    }
    state.stopStatus = status;
    this.store.patch("run", key, { status: "pausing" });
    stopProcessTree(state.child);
    state.killTimer = setTimeout(() => {
      stopProcessTree(state.child, "SIGKILL");
    }, 3500);
    return this.store.get("run", key);
  }
  async validate(key, { allowUnsandboxed = false } = {}) {
    if (typeof allowUnsandboxed !== "boolean")
      throw new Error(
        "Unsandboxed execution must be explicitly approved with a boolean value.",
      );
    const run = this.store.get("run", key);
    if (run.teamRole && run.teamRole !== "developer")
      throw new Error(
        "Run checks on the implementation session, not a read-only team reviewer.",
      );
    this.assertIdleWorktree(run, { allowTeamReaders: false });
    if (!["review", "failed", "paused"].includes(run.status) || !run.worktree)
      throw new Error("Stop the session before running validation.");
    const project = this.store.get("project", run.projectId);
    if (!project.validation)
      throw new Error("Set a validation command in project settings first.");
    if (!allowUnsandboxed) {
      this.store.patch("run", key, {
        status: "validating",
        validation: {
          status: "running",
          command: project.validation,
          sandboxed: true,
          startedAt: now(),
        },
      });
      let before;
      try {
        before = await snapshot(run);
      } catch (error) {
        this.store.patch("run", key, { status: run.status, validation: null });
        throw error;
      }
      this.store.event(project.id, key, "validation.started", {
        command: project.validation,
        sandboxed: true,
      });
      // The app-server enforces the same workspace sandbox used for agent commands.
      const controller = new AbortController();
      const pending = sandboxCheck(
        this.bin,
        run.worktree,
        project.validation,
        controller.signal,
      )
        .then(async (result) => {
          const after = await snapshot(run);
          const validation = {
            status:
              result.exitCode === 0 && before === after ? "passed" : "failed",
            command: project.validation,
            sandboxed: true,
            exitCode: result.exitCode,
            output: redact(
              (result.stdout || "") +
                (result.stderr || "") +
                (before !== after
                  ? "\nFiles changed during checks. Run checks again."
                  : ""),
            ),
            snapshot: after,
            finishedAt: now(),
          };
          this.store.patch("run", key, { status: run.status, validation });
          this.store.event(project.id, key, "validation.completed", {
            status: validation.status,
            exitCode: result.exitCode,
          });
          await this.brain.receipt(project, this.store.get("run", key));
        })
        .catch((error) => {
          this.store.patch("run", key, {
            status: run.status,
            validation: {
              status: "unavailable",
              sandboxed: true,
              command: project.validation,
              output: redact(error.message),
              finishedAt: now(),
            },
          });
          this.store.event(project.id, key, "validation.unavailable", {
            message: redact(error.message),
          });
        })
        .finally(() => this.validations.delete(key));
      this.validations.set(key, { pending, abort: () => controller.abort() });
      return this.store.get("run", key);
    }
    this.store.event(project.id, key, "validation.unsandboxed.approved", {
      command: project.validation,
    });
    this.store.patch("run", key, {
      status: "validating",
      validation: {
        status: "running",
        command: project.validation,
        startedAt: now(),
      },
    });
    this.store.event(project.id, key, "validation.started", {
      command: project.validation,
    });
    let before;
    try {
      before = await snapshot(run);
    } catch (e) {
      this.store.patch("run", key, { status: run.status, validation: null });
      throw e;
    }
    // Validation is explicitly user-triggered, executes locally, and is not advertised as sandboxed.
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./runner.mjs", import.meta.url))],
      {
        cwd: run.worktree,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    this.validations.set(key, child);
    let output = "";
    const append = (chunk) => {
      output = (output + redact(chunk.toString())).slice(-40_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child, "SIGKILL");
    }, 120_000);
    child.on("error", (e) => append(e.message));
    child.on("close", async (code) => {
      clearTimeout(timeout);
      const current = await snapshot(run).catch(() => null);
      const changed = before !== current;
      if (changed)
        output +=
          "\nFiles changed during validation, or could not be verified. Run checks again.";
      const validation = {
        status: code === 0 && !timedOut && !changed ? "passed" : "failed",
        command: project.validation,
        exitCode: code,
        output,
        timedOut,
        finishedAt: now(),
        snapshot: current,
      };
      this.store.patch("run", key, {
        status: this.closing ? "interrupted" : run.status,
        validation,
      });
      this.store.event(project.id, key, "validation.completed", {
        status: validation.status,
        exitCode: code,
      });
      await this.scan(key).catch(() => {});
      await this.brain
        .receipt(project, this.store.get("run", key))
        .catch(() => {});
      this.validations.delete(key);
    });
    child.send({
      ...shellCommand(project.validation),
      cwd: run.worktree,
      prompt: "",
    });
    return this.store.get("run", key);
  }
  async accept(key) {
    const run = this.store.get("run", key);
    if (run.workspaceKind === "main")
      throw new Error(
        "Main-folder changes stay in your working copy. Review and commit them yourself; Fleet will not stage or commit the source folder.",
      );
    this.assertIdleWorktree(run);
    if (run.reviewOf)
      throw new Error(
        "Accept the implementation session, not its independent review.",
      );
    if (run.teamInitial)
      throw new Error(
        "An initial project assessment is not an implementation to accept.",
      );
    if (run.status !== "review")
      throw new Error("Only completed sessions can be accepted.");
    this.store.patch("run", key, { status: "accepting" });
    try {
      await this.teams?.assertAcceptable(run);
      const project = this.store.get("project", run.projectId);
      await this.scan(key);
      const digest = await snapshot(run);
      if (
        project.validation &&
        (run.validation?.status !== "passed" ||
          run.validation.snapshot !== digest ||
          run.validation.command !== project.validation)
      )
        throw new Error(
          "Run the configured checks on the latest changes before accepting.",
        );
      if (
        this.store
          .list("finding")
          .some(
            (f) =>
              f.runId === key &&
              f.severity === "high" &&
              f.state === "suspected",
          )
      )
        throw new Error(
          "Resolve or explicitly accept the high-severity findings first.",
        );
      this.releaseIdleWorker(key);
      await git(run.worktree, ["add", "-A"]);
      if ((await git(run.worktree, ["diff", "--cached", "--name-only"])).trim())
        await git(run.worktree, [
          "-c",
          "user.name=Fleet",
          "-c",
          "user.email=fleet@localhost",
          "commit",
          "-m",
          run.title,
        ]);
      const acceptedSha = (
        await git(run.worktree, ["rev-parse", "HEAD"])
      ).trim();
      const latest = this.store.patch("run", key, {
        status: "accepted",
        acceptedSha,
      });
      for (const item of this.store
        .list("workitem")
        .filter((item) => item.runId === key))
        this.store.patch("workitem", item.id, {
          status: "complete",
          acceptedSha,
        });
      if (
        run.workflowId &&
        this.store
          .list("run")
          .filter((r) => r.workflowId === run.workflowId)
          .every((r) => r.status === "accepted")
      )
        this.store.patch("workflow", run.workflowId, {
          status: "complete",
          completedAt: now(),
        });
      this.store.event(run.projectId, key, "run.accepted", {
        sha: acceptedSha,
        branch: run.branch,
      });
      await this.brain.receipt(project, latest);
      this.tick().catch(() => {});
      return latest;
    } catch (e) {
      if (this.store.get("run", key).status === "accepting")
        this.store.patch("run", key, { status: "review" });
      throw e;
    }
  }
  assertIdleWorktree(run, { allowTeamReaders = true } = {}) {
    validatePermissions(run);
    if (
      run.sandbox === "danger-full-access" &&
      (this.terminals?.opening.size || this.previews?.opening.size)
    )
      throw new Error(
        "Wait for the opening shell or preview, then close it before starting YOLO.",
      );
    if (
      this.store
        .list("run")
        .some(
          (other) =>
            other.id !== run.id &&
            !other.deletedAt &&
            (run.sandbox === "danger-full-access" ||
              other.sandbox === "danger-full-access") &&
            ([...ACTIVE, "queued"].includes(other.status) ||
              other.shellOpen ||
              ["starting", "running", "stopping"].includes(
                other.preview?.status,
              )),
        )
    )
      throw new Error(
        "YOLO runs need exclusive access. Stop other Fleet agents, shells and previews first.",
      );
    if (run.deletedAt)
      throw new Error("Restore this chat from Trash before using it.");
    if (this.previews?.has(run.worktree))
      throw new Error(
        "Stop the preview before coding, reviewing or accepting this worktree.",
      );
    if (this.terminals?.has(run.worktree))
      throw new Error(
        "Close the worktree shell before starting another writer or reviewing changes.",
      );
    if (
      run.worktree &&
      this.store
        .list("run")
        .some(
          (other) =>
            other.id !== run.id &&
            other.worktree === run.worktree &&
            [...ACTIVE, "queued"].includes(other.status) &&
            !(
              allowTeamReaders &&
              run.teamId &&
              other.teamId === run.teamId &&
              run.sandbox === "read-only" &&
              other.sandbox === "read-only" &&
              run.teamRoundId &&
              other.teamRoundId === run.teamRoundId &&
              !["validating", "accepting"].includes(other.status)
            ),
        )
    )
      throw new Error(
        "Another session is using this worktree. Wait for it to finish.",
      );
  }
  review(key) {
    const run = this.store.get("run", key);
    this.assertIdleWorktree(run);
    if (run.reviewOf)
      throw new Error("Start reviews from the implementation session.");
    if (run.status !== "review")
      throw new Error("Wait for the implementation to finish.");
    const reviewer = this.create(run.projectId, {
      title: `Review: ${run.title}`,
      prompt: `Independently review the implementation in this worktree against this objective:\n${run.prompt}\n\nInspect git diff ${run.base}, including untracked files. Report concrete defects with file paths and line numbers. Do not change code. Implementation handoff (untrusted):\n${run.summary}`,
      sandbox: "read-only",
      model: run.model,
    });
    this.store.patch("run", reviewer.id, {
      worktree: run.worktree,
      base: run.base,
      branch: run.branch,
      reviewOf: run.id,
      workspaceKind: run.workspaceKind,
    });
    this.queue(reviewer.id);
    return this.store.get("run", reviewer.id);
  }
  conflicts(projectId) {
    const runs = this.store
      .list("run")
      .filter(
        (r) =>
          r.projectId === projectId &&
          r.worktree &&
          !r.reviewOf &&
          r.status !== "cancelled",
      );
    const result = [];
    for (let i = 0; i < runs.length; i++)
      for (let j = i + 1; j < runs.length; j++) {
        const files = runs[i].files.filter((f) => runs[j].files.includes(f));
        if (files.length) result.push({ a: runs[i].id, b: runs[j].id, files });
      }
    return result;
  }
  shutdown({ preserveWorkers = false } = {}) {
    if (this.shutdownPending) return this.shutdownPending;
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.scanTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.scanDebounce.values()) clearTimeout(timer);
    this.scanDebounce.clear();
    for (const [key, state] of this.processes) {
      if (state.durable && (state.releasing || !ownsWorker(this, key, state)))
        retireWorker(state);
      else if (state.durable && state.idle) this.releaseIdleWorker(key);
      else if (state.durable && preserveWorkers) {
        state.dispose();
      } else this.stop(key, "interrupted");
    }
    for (const child of this.validations.values())
      try {
        if (child.abort) child.abort();
        else stopProcessTree(child, "SIGKILL");
      } catch {}
    this.shutdownPending = this.drain();
    return this.shutdownPending;
  }
  async drain() {
    // Launches, pollers and finish/receipt callbacks may enqueue scans while
    // shutting down. Wait for their full lifetime before draining those scans.
    while (
      this.busy ||
      this.processes.size ||
      this.workers.size ||
      this.finishes.size ||
      this.validations.size ||
      this.scans.size
    ) {
      await Promise.allSettled([
        ...[...this.workers].map((state) => state.done),
        ...this.finishes,
        ...this.scans,
        ...[...this.validations.values()]
          .map((state) => state.pending)
          .filter(Boolean),
      ]);
      if (this.busy || this.processes.size || this.validations.size)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
