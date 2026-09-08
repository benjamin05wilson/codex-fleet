import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { git, snapshot } from "../server/git.mjs";
import { parseReview } from "../server/teams.mjs";
import { deleteSession, restoreSession } from "../server/workspace.mjs";
const bin = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out waiting for team state");
}
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-teams-")),
    source = join(root, "source");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await writeFile(join(source, "README.md"), "# Team fixture\n");
  await git(source, ["add", "-A"]);
  await git(source, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "Fixture",
  ]);
  const app = await createApp({
    dataDir: join(root, "data"),
    bin,
    concurrency: 3,
  });
  const project = await app.addProject({
    path: source,
    validation: 'node -e "process.exit(0)"',
  });
  t.after(async () => {
    await app.close();
    await until(() => !app.engine.processes.size && !app.engine.busy);
    await delay(100);
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const team = await app.teams.enable(project.id, {
    approved: true,
    ...options,
  });
  const initial = await until(() =>
    app.store
      .list("team-round")
      .find((r) => r.kind === "initial" && r.status !== "running"),
  );
  assert.equal(initial.status, "completed", JSON.stringify(initial));
  await until(() => !app.teams.busy);
  return { app, root, source, project, team, initial };
}
test("team helpers can be trashed individually and restored without restarting automatic work", async (t) => {
  const { app, team, project } = await setup(t);
  const key = team.members.security;
  const before = app.store.get("run", key);
  deleteSession(app, key, { approved: true });
  assert.ok(app.store.get("run", key).deletedAt);
  assert.equal(app.teams.get(project.id).enabled, false);
  assert.ok(!app.store.get("run", team.members.developer).deletedAt);
  assert.ok(!app.store.get("run", team.members.verification).deletedAt);
  await app.teams.tick();
  assert.equal(app.store.get("run", key).attempt, before.attempt);
  await assert.rejects(
    app.teams.control(project.id, "renew", { approved: true }),
    /Restore.*Trash/,
  );
  const restored = restoreSession(app, key);
  assert.equal(restored.threadId, before.threadId);
  assert.equal(app.teams.get(project.id).enabled, false);
  await app.teams.tick();
  assert.equal(app.store.get("run", key).attempt, before.attempt);
  await app.teams.control(project.id, "renew", { approved: true });
  assert.equal(app.teams.get(project.id).enabled, true);
  deleteSession(app, key, { approved: true });
  deleteSession(app, team.members.developer, { approved: true });
  assert.equal(app.store.get("run", key).deletionRootId, key);
  assert.throws(() => restoreSession(app, key), /parent chat/);
  restoreSession(app, team.members.developer);
  assert.ok(app.store.get("run", key).deletedAt);
  assert.ok(!app.store.get("run", team.members.verification).deletedAt);
  restoreSession(app, key);
  assert.equal(app.teams.get(project.id).enabled, false);
});

test("review startup rechecks Trash after awaiting the target snapshot", async (t) => {
  const { app, team, project } = await setup(t);
  const lead = app.store.get("run", team.members.developer);
  const target = app.engine.create(project.id, {
    title: "Mission task",
    prompt: "Inspect",
    missionId: "mission",
  });
  app.store.patch("run", target.id, {
    worktree: lead.worktree,
    base: lead.base,
    status: "review",
  });
  const rounds = app.store.list("team-round").length;
  const pending = app.teams.review(project.id, target.id);
  deleteSession(app, target.id, { approved: true });
  await assert.rejects(pending, /Wait for the current team sessions/);
  assert.equal(app.store.list("team-round").length, rounds);
  assert.ok(app.store.get("run", target.id).deletedAt);
});

test("team requires explicit approval and validates structured findings", async () => {
  assert.throws(() => parseReview('{"summary":"fake pass"}'), /invalid/);
  assert.throws(
    () =>
      parseReview(
        JSON.stringify({
          summary: "x",
          coverage: "x",
          memory: "",
          findings: [
            {
              title: "x",
              file: "../escape",
              line: 1,
              severity: "high",
              confidence: "high",
              evidence: "x",
              verification: "x",
            },
          ],
        }),
      ),
    /invalid/,
  );
});
test("team boots persistent read-only roles; changed work wakes reviewers exactly once", async (t) => {
  const { app, team, project, source } = await setup(t);
  assert.equal(Object.keys(team.members).length, 3);
  for (const key of Object.values(team.members)) {
    const r = app.store.get("run", key);
    assert.equal(r.sandbox, "read-only");
    assert.ok(r.threadId);
  }
  await assert.rejects(app.teams.enable(project.id, {}), /Approve/);
  const lead = await app.teams.task(project.id, {
    title: "Change",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  const round = await until(() =>
    app.store
      .list("team-round")
      .find((r) => r.kind === "changes" && r.status === "completed"),
  );
  assert.equal(round.targetRunId, lead.id);
  assert.equal(app.store.get("run", team.members.security).attempt, 2);
  assert.equal(app.store.get("run", team.members.verification).attempt, 2);
  assert.equal(app.store.get("run", lead.id).sandbox, "workspace-write");
  await assert.rejects(readFile(join(source, "artifact.txt")), {
    code: "ENOENT",
  });
  await app.teams.tick();
  await app.teams.tick();
  assert.equal(app.store.list("team-round").length, 2);
  assert.equal(round.snapshot, await snapshot(app.store.get("run", lead.id)));
  assert.throws(
    () => app.engine.queue(team.members.security, "edit something"),
    /Reviewers/,
  );
  await assert.rejects(
    app.engine.terminals.open(
      app.store.get("run", team.members.security),
      "test",
    ),
    /writable shell/,
  );
  await assert.rejects(app.engine.validate(team.members.security), /read-only/);
});
test("review queue locks writers while allowing same-round read-only agents together", async (t) => {
  const { app, team, project } = await setup(t);
  await app.teams.task(project.id, {
    title: "Slow review",
    prompt: "TEST_EDIT TEST_DELAY",
    sandbox: "workspace-write",
  });
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "changes" && r.status === "running"),
  );
  const lead = app.store.get("run", team.members.developer);
  assert.throws(() => app.engine.queue(lead.id, "continue"), /Another session/);
  await assert.rejects(app.engine.accept(lead.id), /Another session/);
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "changes" && r.status === "completed"),
  );
});
test("invalid reports fail closed and never automatically retry; external edits stale reports", async (t) => {
  const { app, team, project } = await setup(t);
  await app.teams.task(project.id, {
    title: "Invalid review",
    prompt: "TEST_EDIT TEST_REVIEW_INVALID",
    sandbox: "workspace-write",
  });
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "changes" && r.status === "failed"),
  );
  const attempt = app.store.get("run", team.members.security).attempt;
  await app.teams.tick();
  await app.teams.tick();
  assert.equal(app.store.get("run", team.members.security).attempt, attempt);
  await assert.rejects(
    app.teams.assertAcceptable(app.store.get("run", team.members.developer)),
    /reviews/,
  );
  await app.teams.task(project.id, {
    title: "Valid review",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  const round = await until(() =>
    app.store
      .list("team-round")
      .find((r) => r.kind === "changes" && r.status === "completed"),
  );
  const lead = app.store.get("run", team.members.developer);
  await writeFile(
    join(lead.worktree, "artifact.txt"),
    "external modification\n",
  );
  await assert.rejects(app.teams.assertAcceptable(lead), /stale/);
  await app.engine.scan(lead.id);
  await app.teams.tick();
  assert.equal(app.store.get("team-round", round.id).status, "stale");
});
test("review budgets stop automatic launches and pause preserves the project", async (t) => {
  const { app, team, project, source } = await setup(t, { maxRounds: 1 });
  await app.teams.task(project.id, {
    title: "Budget",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  await until(() =>
    /budget exhausted/.test(app.teams.get(project.id).reason || ""),
  );
  assert.equal(app.store.get("run", team.members.security).attempt, 1);
  await app.teams.control(project.id, "pause", {});
  assert.equal(app.teams.get(project.id).enabled, false);
  assert.equal(
    await readFile(join(source, "README.md"), "utf8"),
    "# Team fixture\n",
  );
  await assert.rejects(app.teams.control(project.id, "renew", {}), /Approve/);
  await app.teams.control(project.id, "renew", { approved: true });
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "changes" && r.status === "completed"),
  );
});
test("findings require human acknowledgement; memory proposals remain excluded context", async (t) => {
  const { app, team, project, initial } = await setup(t, {
    roles: ["developer", "security", "verification", "memory"],
  });
  await until(() => app.store.get("team-round", initial.id).proposal);
  const notes = await app.brain.list(project);
  const proposal = notes.find((n) => n.filename.startsWith("Team proposal"));
  assert.equal(proposal.proposal, true);
  assert.equal(proposal.approved, false);
  const selection = await app.brain.selectContext(project, "regression tests");
  assert.equal(
    selection.notes.some((n) => n.filename === proposal.filename),
    false,
  );
  await app.teams.task(project.id, {
    title: "Finding",
    prompt: "TEST_EDIT TEST_REVIEW_FINDING",
    sandbox: "workspace-write",
  });
  const round = await until(() =>
    app.store
      .list("team-round")
      .find((r) => r.kind === "changes" && r.status === "completed"),
  );
  assert.equal(round.reports.security.findings.length, 1);
  const lead = app.store.get("run", team.members.developer);
  await assert.rejects(app.teams.assertAcceptable(lead), /acknowledge/);
  app.teams.acknowledge(project.id, round.id, "Reviewed the fixture evidence.");
  await app.teams.assertAcceptable(lead);
  await app.engine.validate(lead.id);
  await until(
    () => app.store.get("run", lead.id).validation?.status === "passed",
  );
  await app.engine.accept(lead.id);
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "memory" && r.status === "completed"),
  );
  // A completed round is published before its asynchronous proposal write
  // releases the reconciliation lock. Wait before submitting the next task.
  await until(() => !app.teams.busy);
  const next = await app.teams.task(project.id, {
    title: "Next task",
    prompt: "TEST_EDIT",
    sandbox: "workspace-write",
  });
  assert.notEqual(next.id, lead.id);
  assert.equal(next.threadId, lead.threadId);
  assert.equal(app.store.get("run", lead.id).status, "accepted");
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.targetRunId === next.id && r.status === "completed"),
  );
});
