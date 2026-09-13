import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    createRequire(import.meta.url)("electron"),
    [fileURLToPath(import.meta.url)],
    { env, stdio: "inherit" },
  );
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
} else {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
async function run() {
  const { app, BrowserWindow } = await import("electron");
  const { createNativeTabs } = await import("../desktop/native-tabs.mjs");
  const { browserURL } = await import("../server/browser-network.mjs");
  const { validateNativeAction } =
    await import("../shared/native-browser-actions.mjs");
  const directory = await mkdtemp(join(tmpdir(), "fleet-capabilities-"));
  app.setPath("userData", directory);
  app.commandLine.appendSwitch("site-per-process");
  await app.whenReady();
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/frame")
      return res.end(
        '<input aria-label="Frame control"><button onclick="document.body.dataset.clicked=1">Frame button</button>',
      );
    res.end(
      `<input type="password" aria-label="Password"><input type="file" aria-label="Upload"><div id="host"></div><iframe src="http://localhost:${server.address().port}/frame"></iframe><button onclick="window.open('/frame')">Popup</button><script>const root=document.querySelector('#host').attachShadow({mode:'closed'});root.innerHTML='<input aria-label="Closed control">';</script>`,
    );
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const windows = [];
  const createWindow = () => {
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.push(window);
    return window;
  };
  const window = createWindow();
  const agent = createNativeTabs({
    web: window.webContents,
    createWindow,
    browserURL,
    forbiddenPorts: [4317],
    validateAction: validateNativeAction,
  });
  const watchdog = setTimeout(() => {
    console.error("Browser capability test timed out");
    app.exit(1);
  }, 30000);
  try {
    console.log("Opening fixture");
    await agent.execute({
      action: "navigate",
      url: `http://127.0.0.1:${server.address().port}`,
    });
    console.log("Taking snapshot");
    let snapshot = await agent.execute({ action: "snapshot" });
    const target = (text) => {
      const line = snapshot.elements.find((line) => line.includes(text));
      assert.ok(line, `Missing ${text}: ${snapshot.elements.join("\n")}`);
      return line.split(" ")[0];
    };
    await agent.execute({
      action: "fill",
      target: target("Password"),
      text: "fixture-only-password",
    });
    await agent.execute({
      action: "fill",
      target: target("Closed control"),
      text: "closed shadow works",
    });
    await agent.execute({
      action: "fill",
      target: target("Frame control"),
      text: "iframe works",
    });
    const file = join(directory, "upload.txt");
    await writeFile(file, "fixture upload");
    await agent.execute({
      action: "upload",
      target: target("Upload"),
      files: [file],
    });
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('input[type=file]').files[0].name",
      ),
      "upload.txt",
    );
    const frame = window.webContents.mainFrame.framesInSubtree.find((f) =>
      f.url.endsWith("/frame"),
    );
    assert.equal(
      await frame.executeJavaScript("document.querySelector('input').value"),
      "iframe works",
    );
    snapshot = await agent.execute({ action: "snapshot" });
    assert.equal(
      JSON.stringify(snapshot).includes("fixture-only-password"),
      false,
    );
    console.log("Opening popup");
    const popup = new Promise((resolve) =>
      window.webContents.once("did-create-window", resolve),
    );
    await agent.execute({ action: "click", target: target("Popup") });
    const child = await popup;
    if (child.webContents.isLoading())
      await new Promise((resolve) =>
        child.webContents.once("did-finish-load", resolve),
      );
    assert.equal((await agent.execute({ action: "tabs" })).tabs.length, 2);
    await agent.execute({ action: "switch_tab", tabId: "1" });
    await agent.execute({
      action: "new_tab",
      url: `http://127.0.0.1:${server.address().port}/frame`,
    });
    assert.equal((await agent.execute({ action: "tabs" })).tabs.length, 3);
    await agent.execute({ action: "close_tab", tabId: "3" });
    console.log(
      "PASS: password fill without echo, cross-origin iframe fill, closed shadow fill, file upload, popup and tab control.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    agent.close();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await new Promise((resolve) => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
}
