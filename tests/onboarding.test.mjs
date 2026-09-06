import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { saveOnboarding, onboardingSettings } from "../server/onboarding.mjs";
import {
  quickSession,
  newWorkspaceSession,
  updateSessionOptions,
} from "../server/workspace.mjs";
import { Store } from "../server/store.mjs";
import { codexArgs } from "../server/engine.mjs";
import { sandboxPolicy } from "../server/codex-client.mjs";

const defaults = {
  approved: true,
  sandbox: "workspace-write",
  model: "",
  workspaceMode: "worktree",
  suggestTeam: false,
  includeMemory: false,
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-onboarding-test-"));
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
test("onboarding API requires CSRF, explicit consent and valid defaults; saving creates no agents", async (t) => {
  const { app, root } = await fixture(t);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const state = await fetch(base + "/state").then((r) => r.json());
  assert.equal(state.onboarding, null);
  const post = (value, token = state.csrf) =>
    fetch(base + "/onboarding", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-fleet-token": token } : {}),
      },
      body: JSON.stringify(value),
    });
  assert.equal((await post(defaults, null)).status, 403);
  for (const changed of [
    { approved: false },
    { sandbox: "invalid" },
    { sandbox: "danger-full-access" },
    { model: 5 },
    { model: "a".repeat(151) },
    { workspaceMode: "root" },
    { suggestTeam: "yes" },
    { includeMemory: null },
  ]) {
    assert.equal((await post({ ...defaults, ...changed })).status, 400);
    assert.equal(onboardingSettings(app.store), null);
  }
  assert.equal(
    (await post({ ...defaults, suggestTeam: true, includeMemory: true }))
      .status,
    200,
  );
  assert.equal(app.store.list("run").length, 0);
  assert.equal(app.store.list("project").length, 0);
  assert.equal(app.store.list("team").length, 0);
  assert.equal(
    (
      await post({
        approved: true,
        sandbox: "workspace-write",
        yoloApproved: false,
      })
    ).status,
    200,
  );
  const reopened = new Store(join(root, "data", "fleet.sqlite"));
  assert.equal(onboardingSettings(reopened).suggestTeam, true);
  assert.equal(onboardingSettings(reopened).yoloApproved, false);
  reopened.close();
});
test("permission-only setup needs no workflow fields and preserves legacy settings without starting anything", async (t) => {
  const { app } = await fixture(t);
  const saved = saveOnboarding(app.store, {
    approved: true,
    sandbox: "workspace-write",
    yoloApproved: false,
  });
  for (const key of ["model", "workspaceMode", "suggestTeam", "includeMemory"])
    assert.equal(Object.hasOwn(saved, key), false);
  assert.equal(app.store.list("run").length, 0);
  saveOnboarding(app.store, {
    ...defaults,
    model: "fixture-first",
    workspaceMode: "main",
    suggestTeam: true,
    includeMemory: true,
  });
  const updated = saveOnboarding(app.store, {
    approved: true,
    sandbox: "workspace-write",
    yoloApproved: false,
  });
  assert.equal(updated.model, "fixture-first");
  assert.equal(updated.workspaceMode, "main");
  assert.equal(updated.includeMemory, true);
  assert.equal(app.store.list("run").length, 0);
  assert.equal(app.store.list("team").length, 0);
});
test("new chats default to editing even before setup, while explicit read-only remains available", async (t) => {
  const { app } = await fixture(t);
  const run = await quickSession(app, { approved: true });
  assert.equal(run.sandbox, "workspace-write");
  assert.equal(run.attempt, 0);
  updateSessionOptions(app, run.id, {
    approved: true,
    sandbox: "read-only",
    rememberDefaults: true,
  });
  assert.equal(app.store.get("run", run.id).sandbox, "read-only");
  assert.equal(
    (await quickSession(app, { approved: true })).sandbox,
    "read-only",
  );
});
test("shutdown drains in-flight security scans before the database can close", async (t) => {
  const { app, root } = await fixture(t);
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "scan-close",
    gitApproved: true,
  });
  const run = await newWorkspaceSession(app, {
    approved: true,
    projectId: project.id,
    kind: "main",
  });
  const pending = app.engine.scan(run.id);
  assert.ok(app.engine.scans.has(pending));
  await app.close();
  assert.equal(app.engine.scans.size, 0);
  await assert.doesNotReject(pending);
});
test("global defaults apply to new chats only, respect project overrides, and never change terminal permissions", async (t) => {
  const { app, root } = await fixture(t);
  const existing = await quickSession(app, {
    approved: true,
    sandbox: "read-only",
  });
  saveOnboarding(app.store, {
    ...defaults,
    sandbox: "workspace-write",
    model: " fixture-first ",
    workspaceMode: "main",
    suggestTeam: true,
  });
  assert.equal(app.store.get("run", existing.id).sandbox, "read-only");
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "project",
    gitApproved: true,
  });
  assert.equal(app.teams.get(project.id), undefined);
  const quick = await quickSession(app, {
    approved: true,
    projectId: project.id,
  });
  assert.equal(quick.workspaceKind, "main");
  assert.equal(quick.worktree, project.path);
  assert.equal(quick.sandbox, "workspace-write");
  assert.equal(quick.model, "fixture-first");
  assert.equal(quick.attempt, 0);
  const separate = await newWorkspaceSession(app, {
    approved: true,
    projectId: project.id,
    kind: "worktree",
  });
  assert.notEqual(separate.worktree, project.path);
  assert.equal(separate.sandbox, "workspace-write");
  assert.equal(separate.model, "fixture-first");
  const terminal = await newWorkspaceSession(app, {
    approved: true,
    projectId: project.id,
    kind: "terminal",
  });
  assert.equal(terminal.sandbox, "read-only");
  assert.ok(!terminal.shellOpen);
  app.store.patch("project", project.id, {
    sessionDefaults: { sandbox: "read-only", model: "fixture-second" },
  });
  const override = await newWorkspaceSession(app, {
    approved: true,
    projectId: project.id,
    kind: "main",
  });
  assert.equal(override.sandbox, "read-only");
  assert.equal(override.model, "fixture-second");
  const scratch = await quickSession(app, { approved: true });
  assert.equal(scratch.sandbox, "workspace-write");
  assert.equal(scratch.worktree, undefined);
  assert.ok(app.store.list("run").every((r) => r.attempt === 0));
});
test("YOLO requires explicit approval and is excluded from managed tasks and team settings", async (t) => {
  const { app } = await fixture(t);
  assert.throws(
    () =>
      saveOnboarding(app.store, { ...defaults, sandbox: "danger-full-access" }),
    /acknowledge/,
  );
  saveOnboarding(app.store, {
    ...defaults,
    sandbox: "danger-full-access",
    yoloApproved: true,
  });
  const run = await quickSession(app, { approved: true });
  assert.equal(run.sandbox, "danger-full-access");
  assert.equal(run.yoloApproved, true);
  for (const managed of [
    { workflowId: "w" },
    { missionId: "m" },
    { teamId: "t" },
    { teamRole: "developer" },
    { reviewOf: "r" },
  ]) {
    assert.throws(
      () =>
        app.engine.create(run.projectId, {
          title: "managed",
          prompt: "test",
          sandbox: "danger-full-access",
          yoloApproved: true,
          ...managed,
        }),
      /independent/,
    );
  }
  app.store.patch("run", run.id, {
    sandbox: "read-only",
    yoloApproved: false,
    teamId: "t",
    teamRole: "developer",
  });
  assert.throws(
    () =>
      updateSessionOptions(app, run.id, {
        approved: true,
        sandbox: "danger-full-access",
        yoloApproved: true,
      }),
    /independent/,
  );
  assert.equal(app.store.get("run", run.id).sandbox, "read-only");
});
test("YOLO cannot overlap another Fleet agent, shell, or preview even in a different project", async (t) => {
  const { app } = await fixture(t);
  const a = await quickSession(app, {
    approved: true,
    sandbox: "danger-full-access",
    yoloApproved: true,
  });
  const b = await quickSession(app, { approved: true });
  for (const active of [
    { status: "running" },
    { status: "queued" },
    { shellOpen: true },
    { preview: { status: "running" } },
  ]) {
    app.store.put("run", { ...b, ...active });
    assert.throws(() => app.engine.assertIdleWorktree(a), /exclusive/);
  }
  app.store.put("run", b);
  app.store.patch("run", a.id, { status: "running" });
  assert.throws(() => app.engine.assertIdleWorktree(b), /exclusive/);
  app.store.put("run", a);
  app.engine.assertIdleWorktree(a);
});
test("all sandbox policies map exactly and full access cannot silently lose its acknowledgement", () => {
  assert.deepEqual(sandboxPolicy("/tmp", "read-only"), { type: "readOnly" });
  assert.equal(sandboxPolicy("/tmp", "workspace-write").networkAccess, false);
  assert.deepEqual(sandboxPolicy("/tmp", "danger-full-access"), {
    type: "dangerFullAccess",
  });
  assert.throws(() => sandboxPolicy("/tmp", "unknown"), /Unsupported/);
  assert.throws(
    () => codexArgs({ sandbox: "danger-full-access" }),
    /acknowledge/,
  );
  const args = codexArgs({ sandbox: "danger-full-access", yoloApproved: true });
  assert.ok(args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(args.includes('approval_policy="never"'));
});
test("worker sends full-access policy to the deterministic fixture on both new and resumed turns", async (t) => {
  const { app } = await fixture(t);
  const run = await quickSession(app, {
    approved: true,
    sandbox: "danger-full-access",
    yoloApproved: true,
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    app.engine.queue(run.id, "TEST_POLICY");
    const deadline = Date.now() + 15000;
    while (
      Date.now() < deadline &&
      app.store.get("run", run.id).status !== "review"
    )
      await delay(50);
    const ready = app.store.get("run", run.id);
    assert.equal(ready.status, "review", ready.error);
    assert.equal(ready.attempt, attempt);
    const policy = JSON.parse(
      await readFile(join(ready.worktree, "policy.json"), "utf8"),
    );
    assert.equal(policy.thread.sandbox, "danger-full-access");
    assert.equal(policy.thread.approvalPolicy, "never");
    assert.deepEqual(policy.turn.sandboxPolicy, { type: "dangerFullAccess" });
    assert.equal(policy.turn.approvalPolicy, "never");
  }
});
