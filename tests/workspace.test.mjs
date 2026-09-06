import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import {
  quickSession,
  sessionFiles,
  updateSessionOptions,
} from "../server/workspace.mjs";
import { createWorktree } from "../server/git.mjs";

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
    /Invalid/,
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
    /Invalid/,
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
