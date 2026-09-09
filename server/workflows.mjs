import { id, now } from "./store.mjs";
import { limits } from "./limits.mjs";
export const templates = [
  {
    id: "implement",
    title: "Implement a change",
    sandbox: "workspace-write",
    tasks: [
      {
        title: "Implement and test",
        prompt:
          "Implement the approved objective. Add focused regression tests and run the configured checks.",
      },
    ],
  },
  {
    id: "investigate",
    title: "Investigate a bug",
    sandbox: "read-only",
    tasks: [
      {
        title: "Investigate and explain",
        prompt:
          "Investigate the objective without changing code. Find a reproducible cause, cite files, and propose the smallest fix.",
      },
    ],
  },
  {
    id: "review",
    title: "Review existing changes",
    sandbox: "read-only",
    tasks: [
      {
        title: "Review the implementation",
        prompt:
          "Review the committed implementation for the objective. Report concrete defects with file paths, severity, evidence and suggested verification. Do not edit files.",
      },
    ],
  },
];
export class Workflows {
  constructor(store, engine) {
    this.store = store;
    this.engine = engine;
    this.busy = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
  }
  create(projectId, input) {
    this.store.get("project", projectId);
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 160 ||
      typeof input.objective !== "string" ||
      !input.objective.trim() ||
      input.objective.length > 30000
    )
      throw new Error("A workflow needs a title and objective.");
    const template = templates.find(
      (t) => t.id === (input.templateId || templates[0].id),
    );
    if (!template)
      throw new Error(
        "Unknown workflow template. Reload the available templates.",
      );
    const tasks = input.tasks || template.tasks;
    if (
      !Array.isArray(tasks) ||
      tasks.length < 1 ||
      tasks.length > limits.tasks
    )
      throw new Error("An approved plan contains one to five tasks.");
    for (const [i, t] of tasks.entries()) {
      if (
        typeof t.title !== "string" ||
        !t.title.trim() ||
        t.title.length > 160 ||
        typeof t.prompt !== "string" ||
        !t.prompt.trim() ||
        t.prompt.length > 30000
      )
        throw new Error("Each task needs a title and instruction.");
      if (
        !Array.isArray(t.dependencies || []) ||
        (t.dependencies || []).some(
          (d) => !Number.isInteger(d) || d < 0 || d >= i,
        )
      )
        throw new Error(
          "Dependencies must refer to earlier tasks; cycles are not allowed.",
        );
      if (
        !Array.isArray(t.scopes || []) ||
        (t.scopes || []).some(
          (s) => typeof s !== "string" || s.startsWith("/") || s.includes(".."),
        )
      )
        throw new Error("Scopes must be repository-relative paths.");
    }
    return this.store.put("workflow", {
      id: id(),
      projectId,
      title: input.title.trim(),
      objective: input.objective.trim(),
      templateId: template.id,
      sandbox: template.sandbox,
      tasks: tasks.map((t) => ({
        ...t,
        scopes: t.scopes || [],
        dependencies: t.dependencies || [],
      })),
      limits: {
        concurrency: this.engine.concurrency,
        maxTasks: limits.tasks,
        maxAttempts: limits.attempts,
        timeoutMs: limits.timeoutMs,
      },
      status: "draft",
      createdAt: now(),
    });
  }
  approve(key) {
    const workflow = this.store.get("workflow", key);
    if (workflow.trashPause) {
      if (this.busy) throw new Error("Wait for the workflow update to finish.");
      const runs = this.store.list("run").filter((r) => r.workflowId === key);
      if (runs.some((r) => r.deletedAt))
        throw new Error(
          "Restore this workflow's chats from Trash before resuming it.",
        );
      if (
        !workflow.approvedAt ||
        workflow.status !== "paused" ||
        workflow.reason !== workflow.trashPause.pauseReason ||
        this.store.get("project", workflow.projectId).validation !==
          workflow.validationCommand ||
        workflow.trashPause.reason
      )
        throw new Error(
          "Approve a revised plan before continuing this workflow.",
        );
      const queued = runs.filter(
        (r) =>
          workflow.trashPause.queuedRunIds.includes(r.id) &&
          r.status === "paused",
      );
      for (const run of queued) this.engine.assertIdleWorktree(run);
      this.store.patch("workflow", key, {
        status: workflow.trashPause.status,
        reason: null,
        trashPause: null,
      });
      for (const run of queued)
        this.engine.queue(run.id, run.followup || undefined);
      this.store.event(workflow.projectId, null, "workflow.resumed", {
        id: key,
      });
      return this.store.get("workflow", key);
    }
    if (workflow.approvedAt) return workflow;
    const project = this.store.get("project", workflow.projectId);
    if (workflow.sandbox === "workspace-write" && !project.validation)
      throw new Error(
        "Set a project validation command before approving a coding workflow.",
      );
    return this.store.transaction(() => {
      const runs = [];
      for (const t of workflow.tasks) {
        const run = this.engine.create(workflow.projectId, {
          title: t.title,
          prompt: `Approved objective:\n${workflow.objective}\n\nTask:\n${t.prompt}`,
          sandbox: workflow.sandbox,
          scopes: t.scopes,
          workflowId: key,
          dependencies: t.dependencies.map((i) => runs[i].id),
        });
        runs.push(run);
        this.store.put("workitem", {
          id: id(),
          workflowId: key,
          runId: run.id,
          projectId: workflow.projectId,
          title: t.title,
          acceptance:
            project.validation || "Human review of the investigation evidence",
          status: "open",
        });
      }
      this.store.patch("workflow", key, {
        status: "running",
        approvedAt: now(),
        validationCommand: project.validation,
        runIds: runs.map((r) => r.id),
      });
      for (const r of runs) this.engine.queue(r.id);
      this.store.event(workflow.projectId, null, "workflow.approved", {
        id: key,
        limits: workflow.limits,
      });
      return this.store.get("workflow", key);
    });
  }
  async tick() {
    if (this.busy || this.engine.closing) return;
    this.busy = true;
    try {
      for (const workflow of this.store
        .list("workflow")
        .filter((w) => w.status === "running")) {
        if (
          this.store.get("project", workflow.projectId).validation !==
          workflow.validationCommand
        ) {
          this.store.patch("workflow", workflow.id, {
            status: "needs-attention",
            reason:
              "The acceptance command changed. Approve a revised plan before continuing.",
          });
          for (const run of this.store
            .list("run")
            .filter(
              (r) => r.workflowId === workflow.id && r.status === "queued",
            ))
            this.engine.stop(run.id);
          continue;
        }
        const runs = (workflow.runIds || []).map((id) =>
          this.store.get("run", id),
        );
        for (const run of runs) {
          if (
            run.sandbox === "workspace-write" &&
            run.status === "review" &&
            !run.validation
          )
            await this.engine.validate(run.id);
          else if (
            (run.status === "failed" || run.validation?.status === "failed") &&
            run.attempt < workflow.limits.maxAttempts
          )
            this.engine.queue(
              run.id,
              `Correct the failed attempt within the original scope. Evidence:\n${run.validation?.output || run.error || "No completed turn."}`,
            );
        }
        if (
          runs.every(
            (r) =>
              ["review", "accepted"].includes(r.status) &&
              (r.sandbox === "read-only" || r.validation?.status === "passed"),
          )
        ) {
          this.store.patch("workflow", workflow.id, { status: "needs-review" });
          for (const item of this.store
            .list("workitem")
            .filter((w) => w.workflowId === workflow.id))
            this.store.patch("workitem", item.id, {
              status: "proposed-complete",
            });
        } else if (
          runs.some(
            (r) =>
              (["failed", "paused", "interrupted"].includes(r.status) &&
                r.attempt >= 2) ||
              r.validation?.status === "unavailable" ||
              (r.validation?.status === "failed" && r.attempt >= 2),
          )
        )
          this.store.patch("workflow", workflow.id, {
            status: "needs-attention",
          });
      }
    } finally {
      this.busy = false;
    }
  }
  close() {
    clearInterval(this.timer);
  }
}
