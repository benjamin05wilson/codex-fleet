import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import {
  quickSession,
  newWorkspaceSession,
  sessionFiles,
  updateSessionOptions,
  deleteSession,
  restoreSession,
} from "../server/workspace.mjs";
import { createWorktree, git } from "../server/git.mjs";
import { Store } from "../server/store.mjs";

test("deleting chats is recoverable, durable and preserves worktrees, history and linked reviews", async (t) => {
  const { app, root } = await fixture(t);
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "trash-source",
    gitApproved: true,
  });
  const run = await newWorkspaceSession(app, {
    approved: true,
    projectId: project.id,
    kind: "worktree",
  });
  await writeFile(join(run.worktree, "keep.txt"), "uncommitted work");
  const reviewer = app.engine.create(project.id, {
    title: "Review",
    prompt: "Review this work",
  });
  app.store.patch("run", reviewer.id, {
    worktree: run.worktree,
    reviewOf: run.id,
  });
  app.store.event(project.id, run.id, "test.history", {
    text: "Keep the transcript",
  });
  app.engine.watchWorktree(run);
  assert.throws(() => deleteSession(app, run.id, {}), /Confirm/);
  deleteSession(app, run.id, { approved: true });
  assert.ok(app.store.get("run", run.id).deletedAt);
  assert.ok(app.store.get("run", reviewer.id).deletedAt);
  assert.equal(app.engine.watchers.has(run.id), false);
  assert.equal(
    await readFile(join(run.worktree, "keep.txt"), "utf8"),
    "uncommitted work",
  );
  assert.ok(
    (await git(project.path, ["worktree", "list", "--porcelain"])).includes(
      run.worktree,
    ),
  );
  assert.ok(
    app.store.events({ runId: run.id }).some((e) => e.type === "test.history"),
  );
  const reopened = new Store(join(root, "data", "fleet.sqlite"));
  assert.ok(reopened.get("run", run.id).deletedAt);
  reopened.close();
  assert.throws(() => app.engine.queue(run.id, "Explain"), /Restore/);
  assert.throws(() => restoreSession(app, reviewer.id), /parent chat/);
  const restored = restoreSession(app, run.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(app.store.get("run", reviewer.id).deletedAt, null);
  assert.equal(restored.status, "draft");
  assert.equal(restored.attempt, 0);
  assert.ok(!restored.shellOpen);
});

test("delete refuses live or managed sessions and checks linked reviews before changing any record", async (t) => {
  const { app } = await fixture(t);
  const run = await quickSession(app, { approved: true });
  for (const changed of [
    { status: "running" },
    { status: "queued" },
    { shellOpen: true },
    { preview: { status: "running" } },
    { teamId: "team" },
    { workflowId: "workflow" },
    { missionId: "mission" },
  ]) {
    app.store.put("run", { ...run, ...changed });
    assert.throws(
      () => deleteSession(app, run.id, { approved: true }),
      /Stop|Close|managed/,
    );
    assert.ok(!app.store.get("run", run.id).deletedAt);
  }
  app.store.put("run", run);
  const review = app.engine.create(run.projectId, {
    title: "Review",
    prompt: "Read only",
  });
  app.store.patch("run", review.id, { reviewOf: run.id, status: "running" });
  assert.throws(() => deleteSession(app, run.id, { approved: true }), /Stop/);
  assert.ok(!app.store.get("run", run.id).deletedAt);
  app.store.patch("run", review.id, { status: "draft" });
});

test("delete/restore API enforces CSRF, hides deleted chats from state/search and blocks stale endpoints", async (t) => {
  const { app } = await fixture(t);
  const run = await quickSession(app, { approved: true });
  app.store.patch("run", run.id, { title: "Recoverable conversation" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const state = await fetch(base + "/state").then((r) => r.json());
  const mutate = (path, method, input, token = state.csrf) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "x-fleet-token": token },
      body: JSON.stringify(input),
    });
  assert.equal(
    (await mutate(`/runs/${run.id}`, "DELETE", { approved: true }, "bad"))
      .status,
    403,
  );
  assert.equal((await mutate(`/runs/${run.id}`, "DELETE", {})).status, 400);
  assert.equal(
    (await mutate(`/runs/${run.id}`, "DELETE", { approved: true })).status,
    200,
  );
  const deleted = await fetch(base + "/state").then((r) => r.json());
  assert.equal(deleted.runs.length, 0);
  assert.equal(deleted.deletedRuns[0].id, run.id);
  assert.equal(deleted.deletedRuns[0].prompt, undefined);
  const search = await fetch(base + "/search?q=Recoverable").then((r) =>
    r.json(),
  );
  assert.ok(!search.some((r) => r.kind === "session"));
  for (const path of [`/runs/${run.id}`, `/runs/${run.id}/files`])
    assert.equal((await fetch(base + path)).status, 410);
  for (const action of ["start", "terminal/open", "options", "accept"])
    assert.equal(
      (
        await mutate(`/runs/${run.id}/${action}`, "POST", {
          prompt: "Go",
          approved: true,
        })
      ).status,
      410,
    );
  assert.equal(
    (await mutate(`/runs/${run.id}/restore`, "POST", {}, "bad")).status,
    403,
  );
  assert.equal(
    (await mutate(`/runs/${run.id}/restore`, "POST", {})).status,
    200,
  );
  const restored = await fetch(base + "/state").then((r) => r.json());
  assert.equal(restored.runs[0].id, run.id);
  assert.equal(restored.deletedRuns.length, 0);
  assert.equal(restored.runs[0].attempt, 0);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-workspace-test-"));
  const app = await createApp({
    dataDir: join(root, "data"),
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
  });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const result = fn();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out waiting for fixture session");
}
test("sidebar actions prepare distinct workspaces without changing source edits or starting a model", async (t) => {
  const { app, root } = await fixture(t);
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "source",
    gitApproved: true,
  });
  await writeFile(join(project.path, "user.txt"), "staged user work");
  await git(project.path, ["add", "user.txt"]);
  const before = await git(project.path, ["status", "--porcelain"]);
  const head = await git(project.path, ["rev-parse", "HEAD"]);
  const create = (kind) =>
    newWorkspaceSession(app, { projectId: project.id, approved: true, kind });
  await assert.rejects(
    newWorkspaceSession(app, { projectId: project.id, kind: "main" }),
    /Confirm/,
  );
  await assert.rejects(create("unknown"), /Choose/);
  await assert.rejects(
    newWorkspaceSession(app, {
      projectId: "missing",
      approved: true,
      kind: "main",
    }),
    /not found/,
  );
  assert.equal(app.store.list("run").length, 0);
  const worktree = await create("worktree"),
    main = await create("main"),
    terminal = await create("terminal");
  assert.notEqual(worktree.worktree, project.path);
  assert.match(worktree.branch, /^fleet\//);
  assert.equal(
    (await git(worktree.worktree, ["branch", "--show-current"])).trim(),
    worktree.branch,
  );
  await assert.rejects(readFile(join(worktree.worktree, "user.txt")), {
    code: "ENOENT",
  });
  assert.equal(main.worktree, project.path);
  assert.equal(main.workspaceKind, "main");
  assert.equal(terminal.worktree, project.path);
  for (const run of [worktree, main, terminal]) {
    assert.equal(run.attempt, 0);
    assert.equal(run.waitingForTask, true);
    assert.equal(
      run.sandbox,
      run.sessionKind === "terminal" ? "read-only" : "workspace-write",
    );
    assert.ok(!run.threadId && !run.shellOpen);
  }
  assert.throws(() => app.engine.queue(terminal.id, "TEST_EDIT"), /terminal/);
  await assert.rejects(app.engine.accept(main.id), /will not stage or commit/);
  app.engine.queue(main.id, "TEST_EDIT");
  await until(() => app.store.get("run", main.id).status === "review");
  assert.equal(app.store.get("run", main.id).worktree, project.path);
  assert.equal(
    await readFile(join(project.path, "artifact.txt"), "utf8"),
    "a deterministic test change\n",
  );
  assert.equal(
    (await git(project.path, ["status", "--porcelain"])).replace(
      "?? artifact.txt\n",
      "",
    ),
    before,
  );
  assert.equal(await git(project.path, ["rev-parse", "HEAD"]), head);
});

test("new-session API enforces CSRF and terminals own the actual project folder exclusively", async (t) => {
  const { app, root } = await fixture(t);
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "source",
    gitApproved: true,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const state = await fetch(base + "/state").then((r) => r.json());
  const post = (path, input, token = state.csrf) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fleet-token": token,
        "x-fleet-client": "sidebar-test",
      },
      body: JSON.stringify(input),
    });
  const input = { projectId: project.id, kind: "terminal", approved: true };
  assert.equal((await post("/sessions/new", input, "bad")).status, 403);
  assert.equal(app.store.list("run").length, 0);
  const response = await post("/sessions/new", input);
  assert.equal(response.status, 201);
  const terminal = await response.json();
  const main = await newWorkspaceSession(app, { ...input, kind: "main" });
  const opened = await post(`/runs/${terminal.id}/terminal/open`, {});
  assert.equal(opened.status, 200);
  const { lease } = await opened.json();
  assert.throws(() => app.engine.queue(main.id, "Explain"), /shell/);
  await post(`/runs/${terminal.id}/terminal/input`, {
    lease,
    data: "pwd > shell-location.txt\n",
  });
  await until(() => app.engine.terminals.get(terminal.id).events.length);
  let location;
  for (let i = 0; i < 50; i++) {
    location = await readFile(
      join(project.path, "shell-location.txt"),
      "utf8",
    ).catch(() => "");
    if (location.trim()) break;
    await delay(50);
  }
  assert.equal(location.trim(), project.path);
  assert.equal(
    (await post(`/runs/${terminal.id}/terminal/close`, { lease: "wrong" }))
      .status,
    400,
  );
  await post(`/runs/${terminal.id}/terminal/close`, { lease });
  await until(() => !app.store.get("run", terminal.id).shellOpen);
  assert.equal(app.store.get("run", terminal.id).attempt, 0);
});
test("explicit idle settings apply to the next turn and can be remembered without starting it", async (t) => {
  const { app } = await fixture(t);
  const run = await quickSession(app, { approved: true });
  assert.throws(
    () => updateSessionOptions(app, run.id, { sandbox: "workspace-write" }),
    /Confirm/,
  );
  assert.throws(
    () =>
      updateSessionOptions(app, run.id, {
        approved: true,
        sandbox: "danger-full-access",
      }),
    /acknowledge/,
  );
  const updated = updateSessionOptions(app, run.id, {
    approved: true,
    sandbox: "workspace-write",
    model: "fixture-first",
    rememberDefaults: true,
  });
  assert.equal(updated.attempt, 0);
  assert.equal(updated.waitingForTask, true);
  assert.equal(updated.sandbox, "workspace-write");
  const next = await quickSession(app, { approved: true, useTeam: false });
  assert.equal(next.model, "fixture-first");
  assert.equal(next.sandbox, "workspace-write");
  app.engine.queue(run.id, "TEST_EDIT");
  await until(() => app.store.get("run", run.id).status === "review");
  const files = await sessionFiles(app.store.get("run", run.id));
  assert.ok(files.files.includes("artifact.txt"));
});
test("settings endpoint enforces consent, CSRF, busy-state and reviewer restrictions", async (t) => {
  const { app } = await fixture(t);
  const run = await quickSession(app, { approved: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const state = await fetch(base + "/state").then((r) => r.json());
  const options = { approved: true, sandbox: "workspace-write" };
  const post = (token) =>
    fetch(base + `/runs/${run.id}/options`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-fleet-token": token } : {}),
      },
      body: JSON.stringify(options),
    });
  assert.equal((await post()).status, 403);
  assert.equal((await post(state.csrf)).status, 200);
  app.store.patch("run", run.id, { status: "running" });
  assert.throws(() => updateSessionOptions(app, run.id, options), /idle/);
  app.store.patch("run", run.id, { status: "draft", teamRole: "security" });
  assert.throws(() => updateSessionOptions(app, run.id, options), /idle/);
  app.store.patch("run", run.id, { teamRole: null, shellOpen: true });
  assert.throws(
    () => updateSessionOptions(app, run.id, options),
    /shell|terminal/i,
  );
  assert.equal(app.store.get("run", run.id).attempt, 0);
});
test("blank scratch conversations are isolated and make no model call until instructed", async (t) => {
  const { app } = await fixture(t);
  const first = await quickSession(app, { approved: true });
  const second = await quickSession(app, { approved: true });
  assert.notEqual(first.projectId, second.projectId);
  assert.equal(app.store.get("project", first.projectId).kind, "scratch");
  assert.equal(first.status, "draft");
  assert.equal(first.waitingForTask, true);
  assert.equal(first.attempt, 0);
  assert.ok(!first.worktree && !first.threadId);
  assert.throws(() => app.engine.queue(first.id), /first instruction/);
  assert.equal(app.store.get("run", first.id).waitingForTask, true);
  app.engine.queue(first.id, "Explain this workspace");
  await until(() => app.store.get("run", first.id).status === "review");
  const ready = app.store.get("run", first.id);
  assert.equal(ready.waitingForTask, false);
  assert.equal(ready.title, "Explain this workspace");
  assert.equal(ready.initialPrompt, "Explain this workspace");
  assert.equal(ready.attempt, 1);
  assert.equal(app.store.get("run", second.id).attempt, 0);
});
test("quick sessions require consent, validate permissions and never silently switch a missing project", async (t) => {
  const { app } = await fixture(t);
  await assert.rejects(quickSession(app, {}), /Confirm/);
  await assert.rejects(
    quickSession(app, { approved: true, sandbox: "danger-full-access" }),
    /acknowledge/,
  );
  await assert.rejects(
    quickSession(app, { approved: true, prompt: 123 }),
    /Instruction/,
  );
  await assert.rejects(
    quickSession(app, { approved: true, projectId: "missing" }),
    /not found/,
  );
  await assert.rejects(
    quickSession(app, { approved: true, useTeam: true }),
    /Enable/,
  );
  assert.equal(app.store.list("project").length, 0);
});
test("saved project and scratch defaults are explicit, durable and overridable", async (t) => {
  const { app, root } = await fixture(t);
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "source",
    gitApproved: true,
  });
  await quickSession(app, {
    approved: true,
    projectId: project.id,
    sandbox: "workspace-write",
    model: "fixture-first",
  });
  assert.equal(app.store.get("project", project.id).sessionDefaults, undefined);
  await quickSession(app, {
    approved: true,
    projectId: project.id,
    sandbox: "workspace-write",
    model: "fixture-first",
    rememberDefaults: true,
  });
  const saved = await quickSession(app, {
    approved: true,
    projectId: project.id,
  });
  assert.equal(saved.sandbox, "workspace-write");
  assert.equal(saved.model, "fixture-first");
  const overridden = await quickSession(app, {
    approved: true,
    projectId: project.id,
    sandbox: "read-only",
    model: "",
  });
  assert.equal(overridden.sandbox, "read-only");
  assert.equal(overridden.model, "");
  await quickSession(app, {
    approved: true,
    sandbox: "workspace-write",
    rememberDefaults: true,
  });
  assert.equal(
    (await quickSession(app, { approved: true })).sandbox,
    "workspace-write",
  );
  assert.equal(
    app.store.get("project", project.id).sessionDefaults.model,
    "fixture-first",
  );
});
test("an instruction starts immediately and an approved project team can reuse its Developer", async (t) => {
  const { app, root } = await fixture(t);
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "team-source",
    gitApproved: true,
    team: { approved: true },
  });
  const team = app.teams.get(project.id);
  await assert.rejects(
    quickSession(app, { approved: true, projectId: project.id, useTeam: true }),
    /Enter a task/,
  );
  const run = await quickSession(app, {
    approved: true,
    projectId: project.id,
    useTeam: true,
    prompt: "Inspect this workspace",
    sandbox: "read-only",
  });
  assert.equal(run.id, team.members.developer);
  assert.equal(run.sandbox, "read-only");
  await until(() => app.store.get("run", run.id).status === "review");
  assert.equal(app.store.get("run", run.id).attempt, 1);
});
test("session files reflect untracked work and reject private paths, traversal and external symlinks", async (t) => {
  const { app, root } = await fixture(t);
  const draft = await quickSession(app, { approved: true });
  assert.deepEqual(await sessionFiles(draft), { files: [], pending: true });
  const project = app.store.get("project", draft.projectId);
  const run = app.store.patch(
    "run",
    draft.id,
    await createWorktree(project, draft, app.engine.dataDir),
  );
  await writeFile(join(run.worktree, "app.js"), "// current working content");
  await writeFile(join(run.worktree, ".env"), "never-return-this");
  await mkdir(join(run.worktree, ".ssh"));
  await writeFile(join(run.worktree, ".ssh", "config"), "private-host");
  await writeFile(join(root, "outside.txt"), "external-private-content");
  await symlink(join(root, "outside.txt"), join(run.worktree, "link.txt"));
  const listing = await sessionFiles(run);
  assert.ok(listing.files.includes("app.js"));
  assert.ok(
    !listing.files.includes(".env") && !listing.files.includes(".ssh/config"),
  );
  assert.equal(
    (await sessionFiles(run, "app.js")).content,
    "// current working content",
  );
  for (const path of [".env", ".ssh/config", "../outside.txt", "/etc/passwd"])
    await assert.rejects(sessionFiles(run, path), /excluded|outside/);
  assert.ok(
    !(await sessionFiles(run, "link.txt")).content.includes(
      "external-private-content",
    ),
  );
});
