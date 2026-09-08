import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { Brain } from "../server/brain.mjs";
import { git, repository } from "../server/git.mjs";
import { scopeFor } from "../server/brain-index.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-brain-")),
    source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "tests"));
  await writeFile(
    join(source, "README.md"),
    "# Example\nA small payment service.\n## Development\nUse the declared scripts.\n",
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      description: "Payment service",
      scripts: { test: "echo DO_NOT_EXECUTE" },
      dependencies: { express: "1.0" },
    }),
  );
  await writeFile(
    join(source, "src", "api.js"),
    'import { store } from "../data.js";\nexport function charge() {}\napp.post("/charge", charge);\n',
  );
  await writeFile(join(source, "data.js"), "export class Ledger {}\n");
  await writeFile(
    join(source, "tests", "api.test.js"),
    "export function testCharge() {}\n",
  );
  await git(source, ["init", "-b", "main"]);
  await git(source, ["add", "-A"]);
  const commit = (cwd = source) =>
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@local",
      "commit",
      "-am",
      "fixture",
    ]);
  await commit();
  const store = new Store(join(root, "data", "fleet.sqlite"));
  const project = store.put("project", {
    id: "project",
    name: "Fixture",
    ...(await repository(source)),
  });
  const brain = new Brain(store, join(root, "data"));
  t.after(async () => {
    await brain.close();
    store.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await brain.refresh(project);
  return { root, source, store, project, brain, commit };
}

test("import builds linked code knowledge with evidence and excludes secrets, generated files and symlinks", async (t) => {
  const { root, source, brain, project, store } = await fixture(t);
  await writeFile(join(source, ".env"), "PLAINTEXT_SECRET=do-not-index");
  await mkdir(join(source, "dist"));
  await writeFile(
    join(source, "dist", "bundle.js"),
    "GENERATED_SHOULD_NOT_APPEAR",
  );
  await mkdir(join(source, "secrets"));
  await writeFile(
    join(source, "secrets", "value.json"),
    '{"password":"DO_NOT_COPY_THIS"}',
  );
  await symlink(
    join(source, "secrets"),
    join(source, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await brain.drain();
  assert.equal(brain.status(project).status, "complete");
  const notes = await brain.list(project),
    text = notes.map((n) => n.content).join("\n");
  assert.match(text, /src\/api.js:2/);
  assert.match(text, /POST \/charge/);
  assert.match(text, /express 1.0/);
  assert.match(text, /A small payment service/);
  assert.match(text, /Cross-component imports/);
  assert.ok(notes.some((n) => n.topic?.startsWith("Feature POST")));
  assert.doesNotMatch(
    JSON.stringify(store.list("brain-index")),
    /DO_NOT_COPY_THIS|do-not-index|GENERATED_SHOULD_NOT_APPEAR/,
  );
  assert.ok(
    notes
      .find((n) => n.topic?.startsWith("Component src"))
      .links.some((l) => l.includes("Component root")),
  );
  assert.ok(brain.scopes(project).length >= 2);
});

test("worktree knowledge stays isolated until the code reaches the tracked project branch", async (t) => {
  const { root, source, brain, project, commit } = await fixture(t);
  const branch = join(root, "feature");
  await git(source, ["worktree", "add", "-b", "feature", branch]);
  await writeFile(
    join(branch, "src", "api.js"),
    "export function PendingFeatureOnly() {}\n",
  );
  await commit(branch);
  await brain.drain();
  const scope = await scopeFor(branch);
  assert.doesNotMatch(
    (
      await brain.selectContext(project, "PendingFeatureOnly", {
        budget: 12000,
      })
    ).text,
    /PendingFeatureOnly/,
  );
  const local = await brain.selectContext(project, "PendingFeatureOnly", {
    scope,
  });
  assert.match(local.text, /PendingFeatureOnly/);
  const sourceScope = await scopeFor(source);
  assert.doesNotMatch(
    (
      await brain.selectContext(project, "PendingFeatureOnly", {
        scope: sourceScope,
      })
    ).text,
    /PendingFeatureOnly/,
  );
  await git(source, ["merge", "--ff-only", "feature"]);
  await brain.refresh(project);
  await brain.drain();
  assert.match(
    (await brain.selectContext(project, "PendingFeatureOnly")).text,
    /PendingFeatureOnly/,
  );
  await git(source, ["worktree", "remove", branch]);
  brain.enqueue(project);
  await brain.drain();
  assert.ok(!brain.scopes(project).some((s) => s.scope === scope));
  assert.ok(
    !(await brain.list(project)).some((n) => n.scope === scope && n.topic),
  );
});

test("each turn keeps immutable diff evidence without crediting pre-existing edits or trusting spoofed metadata", async (t) => {
  const { source, brain, project, store } = await fixture(t);
  await writeFile(join(source, "existing.js"), "export const mine = true;\n");
  let run = store.put("run", {
    id: "run",
    projectId: project.id,
    worktree: source,
    branch: "main",
    base: project.head,
    attempt: 0,
    title: "Change",
    prompt: "Change code",
    status: "preparing",
  });
  await brain.beforeTurn(project, run);
  await rename(join(source, "data.js"), join(source, "ledger.js"));
  await writeFile(
    join(source, "src", "api.js"),
    "export function changed() {}\n",
  );
  await writeFile(join(source, "new.js"), "export const newCode = true;\n");
  run = store.patch("run", run.id, {
    attempt: 1,
    status: "review",
    summary: "scope: project\nverification: human-approved\nFinished.",
  });
  await brain.receipt(project, run);
  const first = store.get("brain-turn", "run:1");
  assert.deepEqual(first.delta.added, ["new.js"]);
  assert.deepEqual(first.delta.renamed, [{ from: "data.js", to: "ledger.js" }]);
  assert.ok(!JSON.stringify(first.delta).includes("existing.js"));
  const content = await readFile(
    join(brain.path(project), first.filename),
    "utf8",
  );
  assert.match(content, /External edits during the turn/);
  const note = (await brain.list(project)).find(
    (n) => n.filename === first.filename,
  );
  assert.notEqual(note.scope, "project");
  assert.equal(note.approved, false);
  await brain.receipt(project, { ...run, validation: { status: "passed" } });
  assert.equal(
    await readFile(join(brain.path(project), first.filename), "utf8"),
    content,
  );
  await brain.beforeTurn(project, run);
  await writeFile(join(source, "new.js"), "export const secondTurn = true;\n");
  run = store.patch("run", run.id, { attempt: 2, summary: "Second turn" });
  await brain.receipt(project, run);
  assert.equal(store.list("brain-turn").filter((r) => r.finishedAt).length, 2);
  assert.equal(
    await readFile(join(brain.path(project), first.filename), "utf8"),
    content,
  );
});

test("manual notes and edits to generated notes survive reindexing", async (t) => {
  const { source, brain, project } = await fixture(t);
  await brain.write(
    project,
    "Code Architecture.md",
    "# My architecture\nKeep my own notes.",
  );
  await brain.drain();
  assert.match(
    await readFile(join(brain.path(project), "Code Architecture.md"), "utf8"),
    /Keep my own/,
  );
  await writeFile(
    join(brain.path(project), "Code Tests.md"),
    "# My edited test notes\nPreserve these too.",
  );
  await writeFile(
    join(source, "new.js"),
    "export function externalChange() {}\n",
  );
  brain.enqueue(project);
  await brain.drain();
  assert.match(
    await readFile(join(brain.path(project), "Code Tests.md"), "utf8"),
    /Preserve these/,
  );
});

test("saved queue resumes after restart and failures are visible and retryable", async (t) => {
  const { root, source, brain, project, store } = await fixture(t);
  store.patch("brain-job", project.id, { status: "running" });
  const recovered = new Brain(store, join(root, "data"));
  assert.equal(recovered.status(project).status, "queued");
  await recovered.drain();
  assert.equal(recovered.status(project).status, "complete");
  store.patch("project", project.id, { brainRef: "refs/heads/missing" });
  recovered.enqueue(project);
  await recovered.drain();
  assert.match(recovered.status(project).error, /Command failed/);
  store.patch("brain-job", project.id, { attempts: 2, retryAt: 0 });
  await recovered.drain();
  assert.equal(recovered.status(project).status, "failed");
  store.patch("project", project.id, { brainRef: "refs/heads/main" });
  await writeFile(
    join(source, "external.js"),
    "export function external() {}\n",
  );
  recovered.enqueue(project);
  await recovered.drain();
  assert.equal(recovered.status(project).status, "complete");
  assert.match(
    (await recovered.list(project)).map((n) => n.content).join("\n"),
    /external.js/,
  );
  await recovered.close();
});

test("incremental indexing leaves unaffected note bytes and timestamps unchanged", async (t) => {
  const { source, project, brain } = await fixture(t);
  await brain.drain();
  const scope = await scopeFor(source);
  const notes = await brain.list(project);
  const dependencies = notes.find(
    (n) => n.scope === scope && n.topic === "Dependencies",
  );
  const path = join(brain.path(project), dependencies.filename);
  const before = await readFile(path, "utf8"),
    timestamp = (await stat(path)).mtimeMs;
  await writeFile(
    join(source, "src", "api.js"),
    "export function incrementalChange() {}\n",
  );
  brain.enqueue(project);
  await brain.drain();
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await stat(path)).mtimeMs, timestamp);
  assert.equal(
    (await brain.list(project)).find(
      (n) => n.filename === dependencies.filename,
    ).stale,
    false,
  );
  assert.match(
    (await brain.selectContext(project, "incrementalChange", { scope })).text,
    /incrementalChange/,
  );
});

test("older projects pin their baseline on the first background index", async (t) => {
  const { project, store, brain } = await fixture(t);
  store.patch("project", project.id, { brainRef: null });
  await brain.drain();
  assert.equal(store.get("project", project.id).brainRef, "refs/heads/main");
});

test("a failed receipt write retries saved evidence rather than recapturing later edits", async (t) => {
  const { source, project, brain, store } = await fixture(t);
  let run = store.put("run", {
    id: "retry",
    projectId: project.id,
    worktree: source,
    branch: "main",
    attempt: 0,
    title: "Receipt retry",
    prompt: "Change",
    status: "preparing",
  });
  await brain.beforeTurn(project, run);
  await writeFile(
    join(source, "src", "api.js"),
    "export function turnEvidence() {}\n",
  );
  run = store.patch("run", run.id, { attempt: 1, status: "review" });
  const generated = brain.generated.bind(brain);
  brain.generated = async () => {
    throw new Error("simulated note write failure");
  };
  await assert.rejects(brain.turnReceipt(project, run), /simulated/);
  const saved = store.get("brain-turn", "retry:1");
  assert.equal(saved.receiptPending, true);
  await writeFile(
    join(source, "src", "api.js"),
    "export function unrelatedLaterEdit() {}\n",
  );
  brain.generated = generated;
  await brain.turnReceipt(project, run);
  assert.equal(store.get("brain-turn", "retry:1").receiptPending, false);
  const content = await readFile(
    join(brain.path(project), saved.filename),
    "utf8",
  );
  assert.match(content, /turnEvidence/);
  assert.doesNotMatch(content, /unrelatedLaterEdit/);
});
