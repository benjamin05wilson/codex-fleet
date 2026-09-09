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
  await mkdir(join(source, "wiki"));
  await writeFile(
    join(source, "wiki", "Checkout.md"),
    "# Checkout Wiki\n\n## Behaviour\n\nUses src/checkout.js.\n\n## Caveats\n\nNot runtime verified.\n",
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
    const { BrainWriter } = await import("../server/brain-writer.mjs");
    await runtime.brain.writer.close();
    runtime.brain.writer = new BrainWriter(runtime.store, {
      bin: fileURLToPath(
        new URL("./fixtures/brain-writer.mjs", import.meta.url),
      ),
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
      name: "Brain fixture",
    });
    await runtime.brain.drain();
    let written;
    for (let batch = 0; batch < 8; batch++) {
      await runtime.brain.writer.drain();
      await runtime.brain.drain();
      written = (await runtime.brain.list(project, { scope: "project" })).find(
        (n) => n.sourcePath === "wiki/Checkout.md",
      );
      if (written?.content.includes("A fixture wiki section")) break;
    }
    assert.match(written.content, /A fixture wiki section/);
    assert.doesNotMatch(written.content, /auto-written analysis/);
    assert.equal(runtime.brain.status(project).status, "complete");
    if (process.argv.includes("--large")) {
      for (let i = 0; i < 500; i++)
        await writeFile(
          join(runtime.brain.path(project), `Large-${i}.md`),
          `# Large ${i}\n\n[[Large-${(i + 1) % 500}]] [[Large-${(i + 7) % 500}]]\n\n` +
            "Project architecture and implementation details.\n".repeat(220),
        );
    }
    await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
    const env = {
      ...process.env,
      FLEET_BRAIN_TEST_ORIGIN: `http://127.0.0.1:${runtime.server.address().port}`,
      FLEET_BRAIN_TEST_DIRECTORY: directory,
      FLEET_BRAIN_TEST_LARGE: process.argv.includes("--large") ? "1" : "",
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
    if (process.env.FLEET_BRAIN_TEST_LARGE)
      await evaluate(`
      window.brainPerf = {longTasks: [], gaps: []};
      new PerformanceObserver(list => brainPerf.longTasks.push(...list.getEntries().map(e => e.duration))).observe({type:'longtask', buffered:false});
      let last;
      function sample(t) { if (last) brainPerf.gaps.push(t-last); last=t; window.brainFrame=requestAnimationFrame(sample); }
      window.brainFrame=requestAnimationFrame(sample);
    `);
    await evaluate(
      `document.querySelector('[aria-label="Project brain"]').click()`,
    );
    await until(`document.querySelectorAll('.graph-node').length >= 6`);
    if (process.env.FLEET_BRAIN_TEST_LARGE) {
      await until(`document.querySelectorAll('.graph-node').length === 500`);
      assert.ok(
        await evaluate(`document.querySelectorAll('.graph-edge').length > 900`),
      );
      await new Promise((r) => setTimeout(r, 5500));
      await until(
        `document.querySelector('.brain-graph').dataset.animating === 'false'`,
      );
      await evaluate(
        `document.querySelector('.graph-node[data-note="Large-0.md"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`,
      );
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(
        await evaluate(
          `document.querySelector('.brain-graph').dataset.animating`,
        ),
        "false",
        "selection must not restart physics",
      );
      const search = async (value) =>
        evaluate(`(() => {
        const input = document.querySelector('[aria-label="Search graph"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
      await search("implementation details");
      await until(`document.querySelectorAll('.graph-node').length > 400`);
      await search("nothing-matches-this");
      await until(`document.querySelectorAll('.graph-node').length === 0`);
      await search("");
      await until(`document.querySelectorAll('.graph-node').length === 500`);
      const transform = () =>
        evaluate(
          `document.querySelector('.brain-graph-canvas > g').getAttribute('transform')`,
        );
      const beforeZoom = await transform();
      await evaluate(
        `document.querySelector('[aria-label="Zoom in"]').click()`,
      );
      await until(
        `document.querySelector('.brain-graph-canvas > g').getAttribute('transform') !== ${JSON.stringify(beforeZoom)}`,
      );
      await evaluate(
        `document.querySelector('[aria-label="Fit graph"]').click()`,
      );
      // Include an unchanged refresh in the recording; it must not reheat.
      await new Promise((r) => setTimeout(r, 2200));
      assert.equal(
        await evaluate(
          `document.querySelector('.brain-graph').dataset.animating`,
        ),
        "false",
      );
      const metrics = await evaluate(`(() => {
        cancelAnimationFrame(window.brainFrame);
        const gaps=brainPerf.gaps.sort((a,b)=>a-b);
        return {nodes:document.querySelectorAll('.graph-node').length,
          longTasks:brainPerf.longTasks.length, longestTaskMs:Math.round(Math.max(0,...brainPerf.longTasks)),
          frameP95Ms:Math.round(gaps[Math.floor(gaps.length*.95)] || 0), maxFrameMs:Math.round(Math.max(0,...gaps))};
      })()`);
      console.log("Large brain performance:", JSON.stringify(metrics));
      assert.ok(
        metrics.longestTaskMs < 500,
        "large graph must not block the UI for half a second",
      );
      await writeFile(
        join(process.env.FLEET_BRAIN_TEST_DIRECTORY, "brain-large.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      assert.deepEqual(errors, []);
      return;
    }
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
