import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { id, now } from "./store.mjs";
import { git, repository, safeRead, createWorktree, inside } from "./git.mjs";
import { searchablePath } from "./search.mjs";
import { redact } from "./sentinel.mjs";
import { deletionBlockedReason } from "../shared/session-lifecycle.mjs";
import { validatePermissions } from "../shared/permissions.mjs";
import { newSessionDefaults, onboardingSettings } from "./onboarding.mjs";

const liveProjectStatuses = new Set([
  "queued",
  "preparing",
  "running",
  "pausing",
  "validating",
  "accepting",
]);

export function removeProject({ store, engine }, key, input) {
  if (input.approved !== true)
    throw new Error("Confirm removing this project.");
  const project = store.get("project", key);
  if (project.removedAt) return { id: key, removedAt: project.removedAt };
  if (project.kind === "scratch")
    throw new Error("Scratch space cannot be removed as a project folder.");
  const runs = store.list("run").filter((run) => run.projectId === key);
  if (
    runs.some(
      (run) =>
        liveProjectStatuses.has(run.status) ||
        run.shellOpen ||
        ["starting", "running", "stopping"].includes(run.preview?.status),
    )
  )
    throw new Error(
      "Stop this project's active chats, terminals and previews before removing it.",
    );
  for (const run of runs) {
    engine.releaseIdleWorker(run.id);
    engine.watchers.get(run.id)?.close();
    engine.watchers.delete(run.id);
    clearTimeout(engine.scanDebounce.get(run.id));
    engine.scanDebounce.delete(run.id);
  }
  const removedAt = now();
  store.patch("project", key, { removedAt });
  store.event(key, null, "project.removed", {
    recoverable: true,
    filesDeleted: false,
  });
  return { id: key, removedAt, filesDeleted: false };
}

export function deleteSession({ store, engine }, key, input) {
  if (input.approved !== true) throw new Error("Confirm deleting this chat.");
  const run = store.get("run", key);
  if (run.reviewOf)
    throw new Error("Delete the parent chat instead of its linked review.");
  if (run.deletedAt) return { id: key, deletedAt: run.deletedAt };
  const related = store
    .list("run")
    .filter((r) => r.id === key || r.reviewOf === key);
  for (const item of related) {
    const reason = deletionBlockedReason(item);
    if (reason) throw new Error(reason);
    engine.assertIdleWorktree(item, { allowTeamReaders: false });
    engine.releaseIdleWorker(item.id);
    if (
      (engine.processes.has(item.id) &&
        !engine.processes.get(item.id).releasing) ||
      engine.validations.has(item.id)
    )
      throw new Error("Wait for this session to stop before deleting it.");
  }
  const deletedAt = now();
  for (const item of related) {
    store.patch("run", item.id, { deletedAt, deletionRootId: key });
    engine.watchers.get(item.id)?.close();
    engine.watchers.delete(item.id);
    clearTimeout(engine.scanDebounce.get(item.id));
    engine.scanDebounce.delete(item.id);
  }
  store.event(run.projectId, key, "session.deleted", { recoverable: true });
  return { id: key, deletedAt };
}

export function restoreSession({ store, engine }, key) {
  const run = store.get("run", key);
  if (run.deletionRootId && run.deletionRootId !== key)
    throw new Error("Restore the parent chat instead of its linked review.");
  if (!run.deletedAt) return run;
  for (const item of store
    .list("run")
    .filter((r) => r.deletionRootId === key)) {
    const restored = store.patch("run", item.id, {
      deletedAt: null,
      deletionRootId: null,
    });
    if (restored.worktree) engine.watchWorktree(restored);
  }
  store.event(run.projectId, key, "session.restored");
  return store.get("run", key);
}

export function sessionDefaults(input = {}) {
  const sandbox = validatePermissions(input),
    model = input.model || "";
  if (typeof model !== "string" || model.length > 150)
    throw new Error("Invalid session defaults.");
  return {
    sandbox,
    model,
    useTeam: input.useTeam === true,
    ...(sandbox === "danger-full-access" ? { yoloApproved: true } : {}),
  };
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
  const saved = newSessionDefaults(app.store, project);
  const defaults = sessionDefaults({ ...saved, ...input });
  if (defaults.useTeam && defaults.sandbox === "danger-full-access")
    throw new Error(
      "YOLO is only available for independent chats, not managed team tasks.",
    );
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
    if (
      project.kind !== "scratch" &&
      onboardingSettings(app.store)?.workspaceMode === "main"
    ) {
      const repo = await repository(project.path);
      run = app.store.patch("run", run.id, {
        worktree: repo.path,
        base: repo.head,
        branch: repo.branch,
        workspaceKind: "main",
        sessionKind: "main",
      });
    }
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
      : sessionDefaults(newSessionDefaults(app.store, project));
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

const fileVersion = (content) =>
  createHash("sha256").update(content).digest("hex");

const validateProjectPath = (path) => {
  if (
    typeof path !== "string" ||
    !path.trim() ||
    path !== path.trim() ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !searchablePath(path)
  )
    throw new Error("Use a safe project-relative path.");
  return path;
};

async function safeProjectParent(root, path) {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of path.split("/").slice(0, -1)) {
    const next = join(current, part);
    const stat = await lstat(next).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!stat) await mkdir(next);
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("A parent path is not a real project folder.");
    current = await realpath(next);
    if (!inside(canonicalRoot, current))
      throw new Error("Path is outside the project folder.");
  }
  return canonicalRoot;
}

export async function writeProjectEntry(project, input) {
  if (project.removedAt)
    throw new Error("Open this project before editing it.");
  const path = validateProjectPath(input.path);
  const root = await safeProjectParent(project.path, path);
  const target = resolve(root, path);
  if (!inside(root, target))
    throw new Error("Path is outside the project folder.");
  if (input.kind === "folder") {
    const stat = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (stat)
      throw new Error(
        stat.isDirectory() && !stat.isSymbolicLink()
          ? "This folder already exists."
          : "A file already uses this path.",
      );
    await mkdir(target, { recursive: false });
    const marker = join(target, ".gitkeep");
    const handle = await open(
      marker,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.close();
    return { path, kind: "folder" };
  }
  if (input.kind !== "file") throw new Error("Choose a file or folder.");
  if (typeof input.content !== "string" || input.content.length > 160_000)
    throw new Error("Files must contain no more than 160,000 characters.");
  const existing = await lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("This path is not an editable file.");
  const current = existing ? await safeRead(root, path) : null;
  if (existing && current === null)
    throw new Error("This file cannot be edited safely.");
  if (
    (existing && input.baseVersion !== fileVersion(current)) ||
    (!existing && input.baseVersion !== null)
  )
    throw Object.assign(
      new Error(
        "This file changed since you opened it. Refresh before saving.",
      ),
      { status: 409 },
    );
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(input.content, "utf8");
  } finally {
    await handle.close();
  }
  return {
    path,
    kind: "file",
    content: input.content,
    version: fileVersion(input.content),
  };
}

export async function sessionFiles(run, path, { redactContent = true } = {}) {
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
  return {
    path,
    content: redactContent ? redact(content) : content,
    version: fileVersion(content),
  };
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
  engine.releaseIdleWorker(key);
  const defaults = sessionDefaults({ ...run, ...input, useTeam: false });
  const updated = store.patch("run", key, {
    sandbox: defaults.sandbox,
    model: defaults.model,
    yoloApproved: defaults.yoloApproved === true,
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
