import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { createNativeBrowser } from "./native-browser.mjs";
import { createNativePageAgent } from "./native-page-agent.mjs";
import { connectNativeAgent } from "./native-agent-bridge.mjs";
import { windowChrome, removeWindowsMenu } from "./window-chrome.mjs";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const root = app.isPackaged
  ? join(process.resourcesPath, "runtime")
  : join(dirname(fileURLToPath(import.meta.url)), "..");
const url = "http://127.0.0.1:" + Number(process.env.FLEET_PORT || 4317);
const { nodeCandidates, desktopEnvironment } = await import(
  pathToFileURL(join(root, "shared/platform.mjs")).href
);
const { managedTools } = await import(
  pathToFileURL(join(root, "shared/managed-tools.mjs")).href
);
const { createClient } = await import(
  pathToFileURL(join(root, "shared/client.mjs")).href
);
const daemonClient = createClient({ base: url + "/api" });
if (app.isPackaged) {
  const tools = managedTools(process.resourcesPath);
  if (tools) {
    process.env.FLEET_MANAGED_TOOLS = "1";
    process.env.FLEET_NODE_BIN ||= tools.node;
    process.env.FLEET_CODEX_BIN ||= tools.codex;
    const env = desktopEnvironment(
      process.env,
      app.getPath("home"),
      tools.node,
    );
    process.env.PATH = [...tools.path, env.PATH].join(
      process.platform === "win32" ? ";" : ":",
    );
  }
}
let window;
let nativeBrowser;
app.commandLine.appendSwitch("disable-quic");
const trial = process.env.FLEET_DESKTOP_TRIAL === "1";
app.setName(trial ? "Fleet Native Preview" : "Fleet");
if (process.platform === "win32") app.setAppUserModelId("dev.fleet.local");
if (trial)
  app.setPath("userData", mkdtempSync(join(tmpdir(), "fleet-native-desktop-")));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    } else app.emit("activate");
  });
  // Electron waits for the entry module to finish before emitting ready.
  // Awaiting readiness at module scope would deadlock packaged startup.
  app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler(
        (_web, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      ipcMain.handle("fleet:choose-repository", async (event) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== url
        )
          throw new Error("Untrusted repository picker request.");
        const result = await dialog.showOpenDialog(window, {
          title: "Choose a project folder or parent location",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : result.filePaths[0] || null;
      });
      ipcMain.handle("fleet:native-browser", (event, input) => {
        if (!nativeBrowser) throw new Error("Native browser is unavailable.");
        return nativeBrowser.handle(event, input);
      });
      ipcMain.handle("fleet:open-sign-in", async (event, authUrl) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== url
        )
          throw new Error("Untrusted sign-in request");
        const { validAuthURL } = await import(
          pathToFileURL(join(root, "shared/auth.mjs")).href
        );
        if (!validAuthURL(authUrl))
          throw new Error("Invalid Codex sign-in address");
        await shell.openExternal(authUrl);
      });
      async function openWindow() {
        try {
          const preferencesPath = join(
            app.getPath("userData"),
            "fleet-runtime.json",
          );
          let previousData;
          try {
            previousData = JSON.parse(
              readFileSync(preferencesPath, "utf8"),
            ).dataDir;
          } catch {}
          let ready = await fetch(url + "/api/bootstrap", {
            headers: { "X-Fleet-Bootstrap": "1" },
          })
            .then((r) => r.ok)
            .catch(() => false);
          if (!ready) {
            if (trial)
              throw new Error(
                "Open your normal Fleet app first. The native preview reuses its running service and never creates a new workspace.",
              );
            const candidates = nodeCandidates(process.env, app.getPath("home"));
            let node;
            for (const bin of candidates) {
              try {
                const probe = JSON.parse(
                  execFileSync(
                    bin,
                    [
                      "-p",
                      'JSON.stringify({major:Number(process.versions.node.split(".")[0]),path:process.execPath})',
                    ],
                    { encoding: "utf8", windowsHide: true, timeout: 5000 },
                  ),
                );
                if (probe.major >= 24 && isAbsolute(probe.path)) {
                  node = probe.path;
                  break;
                }
              } catch {}
            }
            if (!node)
              throw new Error(
                "Install Node.js 24 or set FLEET_NODE_BIN. Fleet’s independent daemon does not run inside Electron.",
              );
            const data =
              process.env.FLEET_DATA_DIR ||
              (previousData && isAbsolute(previousData)
                ? previousData
                : null) ||
              (app.isPackaged
                ? join(app.getPath("userData"), "data")
                : join(root, ".fleet"));
            mkdirSync(data, { recursive: true, mode: 0o700 });
            const log = openSync(join(data, "daemon.log"), "a", 0o600);
            const child = spawn(node, [join(root, "server/index.mjs")], {
              detached: true,
              windowsHide: true,
              stdio: ["ignore", log, log],
              env: {
                ...desktopEnvironment(process.env, app.getPath("home"), node),
                FLEET_DATA_DIR: data,
              },
            });
            child.unref();
            closeSync(log);
            for (let i = 0; i < 80; i++) {
              ready = await fetch(url + "/api/bootstrap", {
                headers: { "X-Fleet-Bootstrap": "1" },
              })
                .then((r) => r.ok)
                .catch(() => false);
              if (ready) break;
              await new Promise((r) => setTimeout(r, 150));
            }
            if (!ready)
              throw new Error(
                "Fleet daemon did not become ready. Inspect daemon.log in the Fleet data directory.",
              );
          }
          const daemonState = await daemonClient.request("/state");
          if (daemonState.status?.dataDir) {
            mkdirSync(app.getPath("userData"), {
              recursive: true,
              mode: 0o700,
            });
            writeFileSync(
              preferencesPath,
              JSON.stringify({ dataDir: daemonState.status.dataDir }),
              { mode: 0o600 },
            );
          }
          window = new BrowserWindow({
            width: 1280,
            height: 880,
            minWidth: 800,
            minHeight: 600,
            backgroundColor: "#151619",
            title: "Fleet",
            ...windowChrome(),
            ...(process.platform === "win32"
              ? {
                  icon: join(
                    dirname(fileURLToPath(import.meta.url)),
                    "assets/fleet.ico",
                  ),
                }
              : {}),
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
              preload: join(
                dirname(fileURLToPath(import.meta.url)),
                "preload.cjs",
              ),
            },
          });
          removeWindowsMenu(window);
          window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          if (trial) {
            window.setTitle("Fleet · Native Preview");
            window.webContents.on("page-title-updated", (event) =>
              event.preventDefault(),
            );
          }
          // Packaged server modules live in Resources/runtime, not app.asar.
          const { browserURL, createBrowserProxy } = await import(
            pathToFileURL(join(root, "server/browser-network.mjs")).href
          );
          const { validateNativeAction } = await import(
            pathToFileURL(join(root, "shared/native-browser-actions.mjs")).href
          );
          const owner = createNativeBrowser({
            browserURL,
            proxyFactory: createBrowserProxy,
            connectAgent: (details) => {
              const agent = createNativePageAgent({
                ...details,
                browserURL,
                validateAction: validateNativeAction,
              });
              const disconnect = connectNativeAgent({
                ...details,
                origin: url,
                execute: (input) => agent.execute(input),
              });
              return async () => {
                agent.close();
                await disconnect();
              };
            },
            window,
            origin: url,
            WebContentsView,
            session,
            validateProject: async (id) => {
              const state = await daemonClient.request("/state");
              return state.projects.some((project) => project.id === id);
            },
          });
          nativeBrowser = owner;
          let disconnectLauncher;
          window.on("closed", () => {
            if (nativeBrowser === owner) nativeBrowser = null;
            disconnectLauncher?.().catch(() => {});
            owner.close().catch(() => {});
          });
          window.webContents.on("will-navigate", (event, target) => {
            if (new URL(target).origin !== url) event.preventDefault();
          });
          const initial = new URL(url);
          if (trial && process.env.FLEET_NATIVE_PROJECT) {
            initial.searchParams.set(
              "nativePreview",
              process.env.FLEET_NATIVE_PROJECT,
            );
            initial.searchParams.set("url", process.env.FLEET_NATIVE_URL || "");
          }
          await window.loadURL(initial.href);
          const desktopWindow = window;
          disconnectLauncher = connectNativeAgent({
            origin: url,
            nativeId: randomUUID(),
            registration: "launcher-register",
            execute: async (input) => {
              const result = await owner.openForAgent(input);
              if (desktopWindow.isDestroyed())
                throw new Error("Fleet window closed.");
              if (desktopWindow.isMinimized()) desktopWindow.restore();
              desktopWindow.show();
              desktopWindow.webContents.send("fleet:browser-requested", {
                projectId: input.projectId,
                runId: input.runId,
                id: randomUUID(),
              });
              return { opened: true, nativeId: result.id };
            },
          });
          if (trial) console.log("Fleet Native Preview ready");
        } catch (error) {
          dialog.showErrorBox("Fleet could not open", error.message);
          app.quit();
        }
      }
      await openWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) openWindow();
      });
      app.on("window-all-closed", () => {
        /* The daemon and execution workers keep running. */
        if (process.platform !== "darwin") app.quit();
      });
    })
    .catch((error) => {
      console.error(error);
      app.quit();
    });
}
