// Explicit, disposable fixture capture. Never reads a remembered Fleet daemon.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = join(root, "docs/evidence");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error("Fixture state timed out");
}
if (!process.versions.electron) {
  process.env.ELECTRON_CACHE = join(root, ".cache/electron");
  const { createApp } = await import("../server/app.mjs");
  const { BrainWriter } = await import("../server/brain-writer.mjs");
  const { git } = await import("../server/git.mjs");
  const dirtyBeforeCapture = !!(
    await git(root, ["status", "--porcelain"])
  ).trim();
  const sourceHashes = {};
  for (const name of [
    "scripts/capture-demo.mjs",
    "tests/fixtures/codex.mjs",
    "tests/fixtures/brain-writer.mjs",
    "package-lock.json",
  ])
    sourceHashes[name] = createHash("sha256")
      .update(await readFile(join(root, name)))
      .digest("hex");
  await mkdir(join(root, ".cache"), { recursive: true });
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(join(root, ".cache/fixture-tour-"));
  const source = join(directory, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "wiki"));
  await writeFile(
    join(source, "README.md"),
    "# Fictional checkout service\nFixture only; no production data.\n",
  );
  await writeFile(
    join(source, "src/checkout.js"),
    "export function checkout() { return 'fixture'; }\n",
  );
  await writeFile(
    join(source, "wiki/Checkout.md"),
    "# Checkout\n\n## Behaviour\nUses src/checkout.js.\n\n## Caveats\nFictional fixture service.\n",
  );
  await writeFile(
    join(source, "check.cjs"),
    "const fs = require('node:fs');\nif (fs.readFileSync('artifact.txt', 'utf8') !== 'a deterministic test change\\n') process.exit(1);\nconsole.log('PASS: deterministic artifact matches expected bytes');\n",
  );
  await git(source, ["init", "-b", "main"]);
  await git(source, ["add", "-A"]);
  await git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Fictional checkout fixture",
  ]);
  const runtime = await createApp({
    dataDir: join(directory, "data"),
    staticDir: join(root, "dist"),
    bin: join(root, "tests/fixtures/codex.mjs"),
  });
  try {
    // Replace writer before adding any project: neither transport can discover Codex.
    await runtime.brain.writer.close();
    runtime.brain.writer = new BrainWriter(runtime.store, {
      bin: join(root, "tests/fixtures/brain-writer.mjs"),
      onWrite: (p) => runtime.brain.enqueue(p),
    });
    runtime.store.put("preferences", {
      id: "onboarding",
      version: 1,
      sandbox: "workspace-write",
      completedAt: new Date().toISOString(),
    });
    const project = await runtime.addProject({
      path: source,
      name: "FIXTURE — Checkout service",
    });
    runtime.store.patch("project", project.id, {
      validation: "node check.cjs",
    });
    const run = runtime.engine.create(project.id, {
      title: "FIXTURE — Review isolated change",
      prompt:
        "TEST_EDIT: create the deterministic artifact for review. Scripted agent output only.",
      sandbox: "workspace-write",
    });
    runtime.engine.queue(run.id);
    await until(() => runtime.store.get("run", run.id).status === "review");
    await runtime.engine.validate(run.id);
    await until(
      () => runtime.store.get("run", run.id).validation?.status === "passed",
    );
    await runtime.brain.drain();
    await runtime.brain.writer.drain();
    await runtime.brain.drain();
    const result = runtime.store.get("run", run.id);
    assert.equal(await git(source, ["status", "--porcelain"]), "");
    assert.equal(
      await readFile(join(result.worktree, "artifact.txt"), "utf8"),
      "a deterministic test change\n",
    );
    await writeFile(
      join(evidence, "fixture-task.json"),
      JSON.stringify(
        {
          kind: "Real Fleet task and validation with scripted Codex/Writer transports",
          dirtyBeforeCapture,
          sourceHashes,
          command: "npm run demo:capture",
          node: process.version,
          platform: process.platform,
          commit: (await git(root, ["rev-parse", "HEAD"])).trim(),
          sourceUnchanged: true,
          status: result.status,
          attempt: result.attempt,
          validation: {
            status: result.validation.status,
            command: result.validation.command,
            note: "Real local command executed by fixture; does not establish Codex sandbox enforcement.",
          },
          artifact: "a deterministic test change\n",
        },
        null,
        2,
      ) + "\n",
    );
    await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
    const env = {
      ...process.env,
      FLEET_TOUR_ORIGIN: `http://127.0.0.1:${runtime.server.address().port}`,
      FLEET_TOUR_DIRECTORY: directory,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      createRequire(import.meta.url)("electron"),
      [fileURLToPath(import.meta.url)],
      { env, stdio: "inherit" },
    );
    const timer = setTimeout(() => child.kill(), 60000);
    try {
      assert.equal(
        await new Promise((r, reject) => {
          child.once("error", reject);
          child.once("close", r);
        }),
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    console.log(
      "Captured real fixture UI in docs/evidence; disposable state removed.",
    );
  } finally {
    await runtime.close();
    runtime.store.close();
    await rm(directory, { recursive: true, force: true });
  }
} else {
  runDesktop().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
async function runDesktop() {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", join(process.env.FLEET_TOUR_DIRECTORY, "profile"));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const evaluate = (s) => window.webContents.executeJavaScript(s);
  const clickText = (text) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))?.click()`,
    );
  const capture = async (name) => {
    await delay(700);
    await writeFile(
      join(evidence, name + ".png"),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  try {
    await window.loadURL(process.env.FLEET_TOUR_ORIGIN);
    await until(() =>
      evaluate(`!!document.querySelector('[aria-label^="Open FIXTURE"]')`),
    );
    await evaluate(
      `document.querySelector('[aria-label^="Open FIXTURE"]').click()`,
    );
    await until(() => evaluate(`!!document.querySelector('.session-row')`));
    await clickText("FIXTURE — Review isolated change");
    await until(() => evaluate(`!!document.querySelector('.tools-menu')`));
    await evaluate(`document.querySelector('.tools-menu').open=true`);
    await clickText("Changes & checks");
    await until(() => evaluate(`!!document.querySelector('.diff .added')`));
    await capture("worktree-review");
    await evaluate(
      `document.querySelector('[aria-label="Project brain"]').click()`,
    );
    await until(() =>
      evaluate(`document.querySelectorAll('.graph-node').length > 0`),
    );
    await clickText("Current worktree");
    await delay(1200);
    await capture("scoped-knowledge");
  } catch (error) {
    console.error(error);
    await capture("capture-failure");
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
}
