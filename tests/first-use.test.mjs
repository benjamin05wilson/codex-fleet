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
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { reviewImport, importProject } from "../server/imports.mjs";
import { createApp } from "../server/app.mjs";
import { git, createWorktree } from "../server/git.mjs";
import { previewPort } from "../server/previews.mjs";
const bin = fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fleet-first-use-"));
  const source = join(root, "source"),
    data = join(root, "data");
  await mkdir(source);
  const apps = [];
  const createRuntime = async () => {
    const app = await createApp({ dataDir: data, bin });
    apps.push(app);
    return app;
  };
  // One owner orders cleanup: after hooks run in registration order. Removing
  // journals before app.close can strand durable workers during reconciliation.
  t.after(async () => {
    for (const app of apps.reverse()) {
      await app.close();
      assert.equal(app.engine.workers.size, 0);
      app.store.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, data, createRuntime };
}
async function until(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out");
}
test("snapshot review excludes secrets, links, binary and dependency files without returning contents", async (t) => {
  const { source } = await fixture(t);
  await writeFile(join(source, "app.js"), "export const ready = true;");
  await writeFile(join(source, ".env"), "PASSWORD=private");
  await writeFile(
    join(source, "token.js"),
    'const apiKey = "test-sensitive-value"',
  );
  await writeFile(join(source, "image.bin"), Buffer.from([0, 1, 2]));
  await mkdir(join(source, "node_modules"));
  await symlink("app.js", join(source, "link.js"));
  const result = await reviewImport(source);
  assert.deepEqual(
    result.files.filter((f) => !f.excluded).map((f) => f.path),
    ["app.js"],
  );
  assert.equal(JSON.stringify(result).includes("test-sensitive-value"), false);
  assert.equal(JSON.stringify(result).includes("export const"), false);
  assert.equal((await readdir(source)).includes(".git"), false);
});
test("approved import contains only selected reviewed bytes and preserves original folder", async (t) => {
  const { source, data } = await fixture(t);
  await writeFile(join(source, "app.js"), "// reviewed code");
  await writeFile(join(source, "omit.txt"), "not selected");
  const review = await reviewImport(source);
  const input = {
    path: source,
    selectedFiles: ["app.js"],
    snapshotDigest: review.digest,
    snapshotApproved: true,
  };
  await assert.rejects(
    importProject({ ...input, snapshotApproved: false }, data),
    /Approve/,
  );
  await assert.rejects(
    importProject({ ...input, selectedFiles: ["../escape"] }, data),
    /eligible/,
  );
  const repo = await importProject(input, data);
  assert.equal(
    await readFile(join(repo.path, "app.js"), "utf8"),
    "// reviewed code",
  );
  assert.equal(
    (await git(repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).trim(),
    "app.js",
  );
  assert.equal((await readdir(source)).includes(".git"), false);
  assert.equal(
    await readFile(join(source, "omit.txt"), "utf8"),
    "not selected",
  );
});
test("snapshot approval expires when source changes and excluded files cannot be forced into import", async (t) => {
  const { source, data } = await fixture(t);
  await writeFile(join(source, "app.js"), "old");
  await writeFile(join(source, ".env"), "secret");
  const review = await reviewImport(source);
  const input = {
    path: source,
    selectedFiles: [".env"],
    snapshotDigest: review.digest,
    snapshotApproved: true,
  };
  await assert.rejects(importProject(input, data), /eligible/);
  await writeFile(join(source, "app.js"), "changed");
  await assert.rejects(
    importProject({ ...input, selectedFiles: ["app.js"] }, data),
    /changed since review/,
  );
});
test("idea setup starts one developer task, defers initial assessment and resumes reviewers afterwards", async (t) => {
  const { source, data, createRuntime } = await fixture(t);
  await writeFile(join(source, "README.md"), "# Existing source");
  const review = await reviewImport(source);
  const app = await createRuntime();
  const input = {
    mode: "import",
    path: source,
    snapshotApproved: true,
    snapshotDigest: review.digest,
    selectedFiles: ["README.md"],
    team: { approved: true },
    firstTask: { approved: true, prompt: "Build the first version" },
  };
  await assert.rejects(
    app.addProject({ ...input, firstTask: { prompt: "No consent" } }),
    /Approve/,
  );
  assert.equal(app.store.list("project").length, 0);
  const project = await app.addProject(input);
  assert.ok(project.firstRunId);
  await until(() =>
    app.store
      .list("team-round")
      .some((r) => r.kind === "changes" && r.status === "completed"),
  );
  assert.equal(
    app.store.list("team-round").some((r) => r.kind === "initial"),
    false,
  );
  assert.equal(app.store.get("run", project.firstRunId).attempt, 1);
  assert.equal(
    app.store.get("run", project.firstRunId).sandbox,
    "workspace-write",
  );
});
test("preview requires approval, owns its lifecycle and blocks concurrent worktree use", async (t) => {
  const { root, data, createRuntime } = await fixture(t);
  const app = await createRuntime();
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "preview-source",
    gitApproved: true,
  });
  const draft = app.engine.create(project.id, {
    title: "Preview",
    prompt: "Preview",
    sandbox: "workspace-write",
  });
  const run = app.store.patch(
    "run",
    draft.id,
    await createWorktree(project, draft, data),
  );
  await writeFile(
    join(run.worktree, "serve.mjs"),
    'import { createServer } from "node:http"; createServer((q,s)=>s.end("preview-ready")).listen(Number(process.argv[2]), "127.0.0.1");',
  );
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  const command = `${JSON.stringify(process.execPath)} serve.mjs ${port}`;
  await assert.rejects(app.previews.start(run, { port, command }), /Approve/);
  await assert.rejects(
    app.previews.start(run, { port, command, approved: true }),
    /already in use/,
  );
  await new Promise((r) => probe.close(r));
  for (const bad of [80, 65536, "https://example.com", 4317])
    assert.throws(() => previewPort(bad, [4317]));
  await app.previews.start(run, { port, command, approved: true });
  assert.throws(() => app.engine.queue(run.id), /Stop the preview/);
  await until(() => app.store.get("run", run.id).preview.status === "running");
  assert.equal(
    await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()),
    "preview-ready",
  );
  await app.previews.stop(run.id);
  assert.equal(app.previews.has(run.worktree), false);
  assert.equal(app.store.get("run", run.id).preview.status, "stopped");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test("fixture shutdown retains a live worker's journal until ownership is released", async (t) => {
  const { root, createRuntime } = await fixture(t);
  const app = await createRuntime();
  const project = await app.addProject({
    mode: "create",
    parentPath: root,
    folderName: "cleanup-source",
    gitApproved: true,
  });
  const run = app.engine.create(project.id, {
    title: "Cleanup ownership",
    prompt: "TEST_HANG",
    sandbox: "read-only",
  });
  app.engine.queue(run.id);
  await until(() => app.store.get("run", run.id).threadId);
  const journal = join(
    app.store.get("run", run.id).worker.directory,
    "status.json",
  );
  const close = app.close;
  app.close = async (...args) => {
    // This fails deterministically if a directory-removal hook runs first,
    // even on a POSIX filesystem that permits unlinking live worker files.
    await assert.doesNotReject(
      readFile(journal),
      "worker journal must exist at shutdown entry",
    );
    await close(...args);
    assert.equal(app.engine.workers.size, 0);
  };
});
