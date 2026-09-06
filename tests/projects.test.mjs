import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { inspectProject, prepareProject } from "../server/projects.mjs";
import { git } from "../server/git.mjs";
import { createApp } from "../server/app.mjs";
const bin = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("create makes an empty local repository only with approval, without overwriting", async (t) => {
  const root = await fixture(t);
  const input = { mode: "create", parentPath: root, folderName: "new project" };
  await assert.rejects(prepareProject(input), /Approve/);
  assert.deepEqual(await readdir(root), []);
  const project = await prepareProject({ ...input, gitApproved: true });
  assert.equal(project.branch, "main");
  assert.equal((await git(project.path, ["ls-tree", "-r", "HEAD"])).trim(), "");
  assert.equal((await git(project.path, ["remote"])).trim(), "");
  await assert.rejects(
    prepareProject({ ...input, gitApproved: true }),
    /EEXIST/,
  );
  for (const folderName of ["../escape", "a/b", ".", ".git", "bad\\name"]) {
    await assert.rejects(
      prepareProject({ ...input, folderName, gitApproved: true }),
      /folder name/,
    );
  }
  await assert.rejects(
    prepareProject({
      ...input,
      parentPath: project.path,
      folderName: "nested",
      gitApproved: true,
    }),
    /outside/,
  );
  await symlink(project.path, join(root, "link"));
  await assert.rejects(inspectProject(join(root, "link")), /symbolic/);
});
test("existing folders are inspected without mutation and initialisation never commits their files", async (t) => {
  const root = await fixture(t);
  const source = join(root, "existing");
  await mkdir(source);
  await writeFile(join(source, ".env"), "PRIVATE=test-secret\n");
  assert.equal((await inspectProject(source)).kind, "folder");
  assert.deepEqual(await readdir(source), [".env"]);
  await assert.rejects(
    prepareProject({ mode: "initialise", path: source }),
    /Approve/,
  );
  await prepareProject({ mode: "initialise", path: source, gitApproved: true });
  assert.equal((await git(source, ["ls-tree", "-r", "HEAD"])).trim(), "");
  assert.equal(
    await readFile(join(source, ".env"), "utf8"),
    "PRIVATE=test-secret\n",
  );
  assert.equal((await inspectProject(source)).kind, "repository");
  await assert.rejects(
    prepareProject({ mode: "initialise", path: source, gitApproved: true }),
    /already has/,
  );
});
test("unborn Git repositories keep staged files out of the empty checkpoint", async (t) => {
  const root = await fixture(t);
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "private.txt"), "untouched");
  await git(root, ["add", "private.txt"]);
  assert.equal((await inspectProject(root)).kind, "unborn");
  await prepareProject({ mode: "initialise", path: root, gitApproved: true });
  assert.equal((await git(root, ["ls-tree", "-r", "HEAD"])).trim(), "");
  assert.match(await git(root, ["status", "--porcelain"]), /A  private.txt/);
});
test("empty project teams use no assessment budget until the first developer task finishes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fleet-empty-team-"));
  const app = await createApp({ dataDir: join(root, "data"), bin });
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "source",
    gitApproved: true,
    team: { approved: true },
  });
  const team = app.teams.get(project.id);
  assert.equal(team.enabled, true);
  assert.equal(team.roundsUsed, 0);
  assert.equal(app.store.list("team-round").length, 0);
  for (const id of Object.values(team.members)) {
    const run = app.store.get("run", id);
    assert.equal(run.status, "draft");
    assert.ok(!run.threadId);
  }
  await app.teams.task(project.id, {
    title: "First task",
    prompt: "Assess the empty project",
    sandbox: "workspace-write",
  });
  const deadline = Date.now() + 20000;
  let round;
  while (Date.now() < deadline) {
    round = app.store.list("team-round").find((r) => r.kind === "changes");
    if (round?.status === "completed") break;
    await delay(50);
  }
  assert.equal(round?.status, "completed", JSON.stringify(round));
  assert.equal(app.teams.get(project.id).roundsUsed, 1);
  assert.equal(
    app.store.list("team-round").some((r) => r.kind === "initial"),
    false,
  );
});
