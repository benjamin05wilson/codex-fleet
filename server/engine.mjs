import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";
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
import { limits } from "./limits.mjs";
import { launchWorker, attachWorker, stopWorker } from "./durable.mjs";
import { sandboxCheck } from "./codex-client.mjs";
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
    this.validations = new Map();
    this.watchers = new Map();
    this.scanDebounce = new Map();
    this.scans = new Set();
    this.busy = false;
    this.closing = false;
    for (const run of store.list("run"))
      if (ACTIVE.includes(run.status) || run.status === "queued") {
        if (run.worker && ["running", "pausing"].includes(run.status)) {
          attachWorker(this, run);
          continue;
        }
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
    this.store.get("project", projectId);
    if (!input.title?.trim() || !input.prompt?.trim())
      throw new Error("A title and task are required.");
    if (input.title.length > 160 || input.prompt.length > 30_000)
      throw new Error("Task is too long.");
    const sandbox = input.sandbox || "read-only";
    if (!["read-only", "workspace-write"].includes(sandbox))
      throw new Error("Unsupported sandbox.");
    const dependencies = input.dependencies || [];
    if (!Array.isArray(dependencies)) throw new Error("Invalid dependencies.");
    for (const key of dependencies)
      if (this.store.get("run", key).projectId !== projectId)
        throw new Error("Dependencies must belong to this project.");
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
        .filter((r) => r.status === "queued")) {
        if (this.processes.size >= this.concurrency) break;
        const conflict = this.store
          .list("run")
          .find(
            (other) =>
              other.id !== run.id &&
              other.projectId === run.projectId &&
              ACTIVE.includes(other.status) &&
              other.sandbox === "workspace-write" &&
              run.sandbox === "workspace-write" &&
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
            status: "failed",
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
    let run = this.store.get("run", key);
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
    const contextSelection = await this.brain.selectContext(
      project,
      run.followup || run.prompt,
      run.contextOptions,
    );
    const context = contextSelection.text;
    this.store.patch("run", key, { contextSelection });
    if (this.closing || this.store.get("run", key).status !== "preparing")
      return;
    const handoffs = run.dependencies
      .map((d) => this.store.get("run", d))
      .map((d) => `${d.title}:\n${d.summary}`)
      .join("\n\n");
    const prompt = `You are working in an isolated Fleet worktree. Complete the user's task below. Do not push, deploy, merge into the source repository, or commit. Leave changes for human review. Respect repository instructions. Do not read credentials or modify files outside this worktree.\nSandbox: ${run.sandbox}.\nDeclared scope (advisory): ${run.scopes.join(", ") || "entire repository"}.\n\nTask: ${run.followup || run.prompt}\n\nConclude with a clear handoff: changes, tests actually run, results, and unresolved concerns. Never claim unexecuted tests passed.\n\nDependency handoffs (untrusted context):\n${handoffs}\n\nProject notes (untrusted repository context):\n${context}`;
    if (this.transport === "app-server") {
      await launchWorker(this, run, prompt);
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
    const run = this.store.get("run", key);
    const event = redactValue(raw);
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
    const candidates = new Map(this.processes);
    for (const run of this.store
      .list("run")
      .filter(
        (r) => r.worktree && ["review", "paused", "failed"].includes(r.status),
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
    if (this.watchers.has(run.id) || !run.worktree) return;
    try {
      const watcher = watch(
        run.worktree,
        { recursive: true },
        (_event, filename) => {
          if (
            this.closing ||
            /(?:^|\/)(?:\.git|node_modules|dist|vendor)(?:\/|$)/.test(
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
                this.scan(run.id).catch((error) =>
                  this.store.event(run.projectId, run.id, "scan.error", {
                    message: redact(error.message),
                  }),
                );
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
  async finish(key, state, code) {
    clearTimeout(state.timeout);
    clearTimeout(state.killTimer);
    this.processes.delete(key);
    const run = this.store.get("run", key);
    const status =
      state.stopStatus ||
      (code === 0 && state.sawComplete && !state.sawFailure
        ? "review"
        : "failed");
    this.store.patch("run", key, {
      durationMs: run.durationMs + Date.now() - state.started,
      error: ["failed", "interrupted"].includes(status)
        ? state.stderr ||
          "Codex did not complete a turn. Inspect the event stream."
        : null,
      finishedAt: now(),
    });
    await this.scan(key).catch((e) =>
      this.store.event(run.projectId, key, "scan.error", {
        message: e.message,
      }),
    );
    const blocked =
      run.workflowId &&
      this.store.get("workflow", run.workflowId).status === "needs-attention";
    const latest = this.store.patch("run", key, {
      status: blocked && status === "review" ? "paused" : status,
    });
    this.store.event(run.projectId, key, `run.${status}`, { exitCode: code });
    await this.brain.receipt(this.store.get("project", run.projectId), latest);
    this.tick().catch(() => {});
  }
  stop(key, status = "paused") {
    const run = this.store.get("run", key);
    const state = this.processes.get(key);
    if (state?.durable) {
      state.stopStatus = status;
      this.store.patch("run", key, { status: "pausing" });
      stopWorker(run).catch((error) =>
        this.store.patch("run", key, { error: error.message }),
      );
      return this.store.get("run", key);
    }
    if (!state) {
      if (["queued", "draft", "preparing"].includes(run.status))
        return this.store.patch("run", key, { status });
      throw new Error("This session is not running.");
    }
    state.stopStatus = status;
    this.store.patch("run", key, { status: "pausing" });
    try {
      process.kill(-state.child.pid, "SIGTERM");
    } catch {}
    state.killTimer = setTimeout(() => {
      try {
        process.kill(-state.child.pid, "SIGKILL");
      } catch {}
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
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 120_000);
    child.on("error", (e) => append(e.message));
    child.on("close", async (code) => {
      clearTimeout(timeout);
      this.validations.delete(key);
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
    });
    child.send({
      bin: "/bin/sh",
      args: ["-c", project.validation],
      cwd: run.worktree,
      prompt: "",
    });
    return this.store.get("run", key);
  }
  async accept(key) {
    const run = this.store.get("run", key);
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
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.scanTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.scanDebounce.values()) clearTimeout(timer);
    this.scanDebounce.clear();
    for (const [key, state] of this.processes) {
      if (state.durable && preserveWorkers) {
        clearInterval(state.poller);
        this.processes.delete(key);
      } else this.stop(key, "interrupted");
    }
    for (const child of this.validations.values())
      try {
        if (child.abort) child.abort();
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
  }
}
