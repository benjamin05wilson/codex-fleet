// Opt-in real Electron UI check. Uses only disposable fixture projects/profiles.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

if (!process.argv.includes("--run")) {
  console.log("Use --run for an isolated brain desktop smoke test.");
} else if (!process.versions.electron) {
  const { createApp } = await import("../server/app.mjs");
  const { git } = await import("../server/git.mjs");
  const directory = await mkdtemp(join(tmpdir(), "fleet-brain-ui-"));
  const source = join(directory, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(
    join(source, "README.md"),
    "# Checkout service\nRoutes and checkout orchestration.\n",
  );
  await writeFile(
    join(source, "src", "checkout.js"),
    'export function checkout() {}\napp.post("/checkout", checkout);\n',
  );
  await git(source, ["init", "-b", "main"]);
  await git(source, ["add", "-A"]);
  await git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local",
    "commit",
    "-m",
    "Fixture",
  ]);
  const runtime = await createApp({
    dataDir: join(directory, "data"),
    staticDir: fileURLToPath(new URL("../dist", import.meta.url)),
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
  });
  try {
    runtime.store.put("preferences", {
      id: "onboarding",
      version: 1,
      sandbox: "workspace-write",
      completedAt: new Date().toISOString(),
    });
    const project = await runtime.addProject({
      path: source,
      name: "Brain fixture",
    });
    await runtime.brain.drain();
    assert.equal(runtime.brain.status(project).status, "complete");
    await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
    const env = {
      ...process.env,
      FLEET_BRAIN_TEST_ORIGIN: `http://127.0.0.1:${runtime.server.address().port}`,
      FLEET_BRAIN_TEST_DIRECTORY: directory,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      createRequire(import.meta.url)("electron"),
      [fileURLToPath(import.meta.url), "--run"],
      { env, stdio: "inherit" },
    );
    const code = await new Promise((r) => child.once("exit", r));
    assert.equal(code, 0);
    console.log(`Retained isolated brain screenshots: ${directory}`);
  } finally {
    await runtime.close();
    runtime.store.close();
  }
} else {
  runDesktop().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
async function runDesktop() {
  const { app, BrowserWindow } = await import("electron");
  app.setPath(
    "userData",
    join(process.env.FLEET_BRAIN_TEST_DIRECTORY, "profile"),
  );
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1400,
    height: 950,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  const evaluate = (s) => window.webContents.executeJavaScript(s);
  const until = async (s) => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(s)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`UI state unavailable: ${s}`);
  };
  try {
    await window.loadURL(process.env.FLEET_BRAIN_TEST_ORIGIN);
    await until(
      `!!document.querySelector('[aria-label^="Open Brain fixture"]')`,
    );
    await evaluate(
      `document.querySelector('[aria-label^="Open Brain fixture"]').click()`,
    );
    await until(`!!document.querySelector('[aria-label="Project brain"]')`);
    await evaluate(
      `document.querySelector('[aria-label="Project brain"]').click()`,
    );
    await until(`document.querySelectorAll('.graph-node').length >= 6`);
    assert.equal(
      await evaluate(`document.querySelectorAll('.graph-node.pending').length`),
      0,
    );
    await evaluate(
      `[...document.querySelectorAll('.brain-scope-bar button')].find(b=>b.textContent==='Current worktree').click()`,
    );
    await until(`document.querySelectorAll('.graph-node.pending').length > 0`);
    for (const [name, width, height] of [
      ["wide", 1400, 950],
      ["compact", 850, 750],
    ]) {
      window.setSize(width, height);
      await new Promise((r) => setTimeout(r, 500));
      const layout = JSON.parse(
        await evaluate(
          `JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,graphHeight:document.querySelector('.brain-graph-canvas').getBoundingClientRect().height})`,
        ),
      );
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      assert.ok(layout.graphHeight > 250, JSON.stringify(layout));
      await writeFile(
        join(process.env.FLEET_BRAIN_TEST_DIRECTORY, `brain-${name}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real brain UI renders indexed relationships, separates scopes, shows pending nodes, and fits wide/compact windows.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode || 0);
  }
}
