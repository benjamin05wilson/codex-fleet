import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { id, now } from "./store.mjs";
import { git, repository, safeRead, createWorktree } from "./git.mjs";
import { searchablePath } from "./search.mjs";
import { redact } from "./sentinel.mjs";

export function sessionDefaults(input = {}) {
  const sandbox = input.sandbox || "read-only",
    model = input.model || "";
  if (
    !["read-only", "workspace-write"].includes(sandbox) ||
    typeof model !== "string" ||
    model.length > 150
  )
    throw new Error("Invalid session defaults.");
  return { sandbox, model, useTeam: input.useTeam === true };
}
export async function quickSession(app, input) {
  if (input.approved !== true)
    throw new Error("Confirm the session permissions before starting.");
  if (
    input.prompt !== undefined &&
    (typeof input.prompt !== "string" || input.prompt.length > 30000)
  )
    throw new Error("Instruction must be at most 30,000 characters.");
  const prompt = input.prompt?.trim() || "";
  let project = input.projectId
    ? app.store.get("project", input.projectId)
    : null;
  const saved =
    project?.sessionDefaults ||
    (!project
      ? app.store.list("preferences").find((p) => p.id === "scratch-session")
      : null) ||
    {};
  const defaults = sessionDefaults({ ...saved, ...input });
  if (defaults.useTeam && (!project || !app.teams.get(project.id)?.enabled))
    throw new Error("Enable the project team before using its Developer.");
  if (defaults.useTeam && !prompt)
    throw new Error(
      "Enter a task to reuse the project Developer, or open an independent conversation.",
    );
  if (!project) {
    const path = join(app.engine.dataDir, "scratch", id());
    await mkdir(path, { recursive: true, mode: 0o700 });
    await git(path, ["init", "--template=", "-b", "main"]);
    await git(path, [
      "-c",
      "user.name=Fleet",
      "-c",
      "user.email=fleet@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "Scratch checkpoint",
    ]);
    project = app.store.put("project", {
      id: id(),
      name: "Scratch",
      kind: "scratch",
      ...(await repository(path)),
      createdAt: now(),
      validation: "",
      example: false,
    });
    await app.brain.refresh(project);
  }
  const task = {
    ...defaults,
    title: prompt ? prompt.split("\n")[0].slice(0, 100) : "New conversation",
    prompt: prompt || "Awaiting your first instruction.",
  };
  let run;
  if (defaults.useTeam && app.teams.get(project.id)?.enabled && prompt)
    run = await app.teams.task(project.id, task);
  else {
    run = app.engine.create(project.id, task);
    if (prompt) run = app.engine.queue(run.id);
    else run = app.store.patch("run", run.id, { waitingForTask: true });
  }
  if (input.rememberDefaults === true) {
    if (project.kind === "scratch")
      app.store.put("preferences", {
        id: "scratch-session",
        ...defaults,
        useTeam: false,
      });
    else app.store.patch("project", project.id, { sessionDefaults: defaults });
  }
  return run;
}
// Explicit sidebar actions prepare a workspace, never start an agent or shell.
export async function newWorkspaceSession(app, input) {
  if (input.approved !== true) throw new Error("Confirm the workspace action.");
  if (!["main", "worktree", "terminal"].includes(input.kind))
    throw new Error("Choose a main chat, Git worktree or terminal.");
  if (!input.projectId) throw new Error("Select a project first.");
  const project = app.store.get("project", input.projectId);
  const repo = await repository(project.path);
  const defaults =
    input.kind === "terminal"
      ? { sandbox: "read-only" }
      : sessionDefaults(project.sessionDefaults || {});
  const run = app.engine.create(project.id, {
    title:
      input.kind === "terminal"
        ? "Terminal"
        : input.kind === "main"
          ? "Main chat"
          : "New worktree",
    prompt: "Awaiting your first instruction.",
    ...defaults,
  });
  try {
    const workspace =
      input.kind === "worktree"
        ? await createWorktree(project, run, app.engine.dataDir)
        : { worktree: repo.path, base: repo.head, branch: repo.branch };
    return app.store.patch("run", run.id, {
      ...workspace,
      sessionKind: input.kind,
      workspaceKind: input.kind === "worktree" ? "worktree" : "main",
      waitingForTask: true,
    });
  } catch (error) {
    app.store.patch("run", run.id, { status: "failed", error: error.message });
    throw error;
  }
}

export async function sessionFiles(run, path) {
  if (!run.worktree) return { files: [], pending: true };
  const files = [
    ...new Set(
      (
        await git(run.worktree, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(Boolean),
    ),
  ]
    .filter(
      (file) =>
        searchablePath(file) &&
        !file
          .split("/")
          .some((part) =>
            /^(?:\.fleet|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(
              part,
            ),
          ),
    )
    .sort();
  if (path === undefined)
    return { files: files.slice(0, 1500), truncated: files.length > 1500 };
  if (
    !files.includes(path) ||
    path.split("/").includes("..") ||
    path.startsWith("/")
  )
    throw new Error("File is excluded or outside this session.");
  const content = await safeRead(run.worktree, path);
  if (content === null)
    return {
      path,
      content: "Preview unavailable: binary, linked or oversized file.",
    };
  return { path, content: redact(content) };
}

export function updateSessionOptions({ store, engine }, key, input) {
  if (input.approved !== true)
    throw new Error("Confirm the session settings before applying them.");
  const run = store.get("run", key);
  if (run.sessionKind === "terminal")
    throw new Error("Terminal sessions do not have Codex settings.");
  if (
    run.shellOpen ||
    ["starting", "running", "stopping"].includes(run.preview?.status)
  )
    throw new Error(
      "Stop the shell or preview before changing conversation settings.",
    );
  if (
    !["draft", "paused", "interrupted", "failed", "review"].includes(
      run.status,
    ) ||
    run.teamInitial ||
    (run.teamRole && run.teamRole !== "developer") ||
    run.workflowId ||
    run.reviewOf
  )
    throw new Error("Settings can only change on an idle coding conversation.");
  engine.assertIdleWorktree(run);
  const defaults = sessionDefaults({ ...run, ...input, useTeam: false });
  const updated = store.patch("run", key, {
    sandbox: defaults.sandbox,
    model: defaults.model,
  });
  if (input.rememberDefaults === true) {
    const project = store.get("project", run.projectId);
    if (project.kind === "scratch")
      store.put("preferences", { id: "scratch-session", ...defaults });
    else store.patch("project", project.id, { sessionDefaults: defaults });
  }
  store.event(run.projectId, key, "session.options.changed", {
    sandbox: defaults.sandbox,
    model: defaults.model,
  });
  return updated;
}
