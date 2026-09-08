// Opt-in native WebContentsView trial. Own window, temporary profile, no agent
// calls or personal Chrome state. --public tests Shopify's public hero video.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
if (!process.argv.includes("--run")) {
  console.log(
    "Use --run for an isolated native desktop browser trial; --public adds Shopify.",
  );
} else if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let agentFixture;
  if (process.argv.includes("--shared")) {
    const { createNativeAgentFixture } =
      await import("./native-agent-fixture.mjs");
    agentFixture = await createNativeAgentFixture();
    Object.assign(env, agentFixture.env);
  }
  if (process.argv.includes("--ui")) {
    const { build } = await import("vite");
    env.FLEET_NATIVE_UI_DIR = await mkdtemp(join(tmpdir(), "fleet-native-ui-"));
    await build({
      configFile: false,
      root: fileURLToPath(new URL("../", import.meta.url)),
      logLevel: "error",
      build: {
        outDir: env.FLEET_NATIVE_UI_DIR,
        rollupOptions: {
          input: fileURLToPath(
            new URL("./fixtures/native-browser.html", import.meta.url),
          ),
        },
      },
    });
  }
  const child = spawn(
    createRequire(import.meta.url)("electron"),
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env, stdio: "inherit" },
  );
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
  await agentFixture?.close();
} else {
  runNative().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
async function runNative() {
  const { app, BrowserWindow, WebContentsView, session, ipcMain } =
    await import("electron");
  const { createNativeBrowser } = await import("../desktop/native-browser.mjs");
  const { createNativePageAgent: makePageAgent } =
    await import("../desktop/native-page-agent.mjs");
  const { connectNativeAgent: connectAgent } =
    await import("../desktop/native-agent-bridge.mjs");
  const { validateNativeAction: validateAction } =
    await import("../shared/native-browser-actions.mjs");
  const { browserURL, createBrowserProxy } =
    await import("../server/browser-network.mjs");
  const directory = await mkdtemp(join(tmpdir(), "fleet-native-trial-"));
  app.setPath("userData", directory);
  app.commandLine.appendSwitch("disable-quic");
  await app.whenReady();
  let internalHits = 0,
    popupWindows = 0,
    assetHits = 0;
  const internal = http.createServer((_req, res) => {
    internalHits++;
    res.end("forbidden");
  });
  await new Promise((r) => internal.listen(0, "127.0.0.1", r));
  const page = http.createServer((req, res) => {
    if (req.url === "/cached-asset") {
      assetHits++;
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end("native cache fixture");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url === "/next"
        ? "<h1>Second page</h1>"
        : `<style>body{margin:20px;height:4000px}input{width:240px;height:40px}</style><h1>Native rendering</h1><input aria-label="Name"><button onclick="window.open('/next')">Popup</button><a href="/next">Next</a><output></output><script>
      fetch('http://127.0.0.1:${internal.address().port}/private',{mode:'no-cors'}).then(()=>{},()=>{});
      document.querySelector('input').oninput=e=>document.querySelector('output').textContent=e.target.value;
    </script>`,
    );
  });
  await new Promise((r) => page.listen(0, "127.0.0.1", r));
  const shell = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    if (
      process.argv.includes("--ui") &&
      (path === "/tests/fixtures/native-browser.html" ||
        /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path))
    ) {
      try {
        res.setHeader(
          "Content-Type",
          path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : "text/html; charset=utf-8",
        );
        res.end(await readFile(join(process.env.FLEET_NATIVE_UI_DIR, path)));
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<title>Fleet native preview trial</title><body style="background:#16181c;color:white;font:16px system-ui">Fleet · Native rendering trial</body>',
    );
  });
  await new Promise((r) => shell.listen(0, "127.0.0.1", r));
  const origin = process.argv.includes("--full-app")
      ? process.env.FLEET_SHARED_TEST_ORIGIN
      : `http://127.0.0.1:${shell.address().port}`,
    pageURL = `http://127.0.0.1:${page.address().port}`;
  const window = new BrowserWindow({
    enableLargerThanScreen: process.argv.includes("--full-app"),
    width: 1280,
    height: 920,
    show: true,
    title: "Fleet native preview trial",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      ...(process.argv.includes("--ui")
        ? {
            preload: fileURLToPath(
              new URL("../desktop/preload.cjs", import.meta.url),
            ),
          }
        : {}),
    },
  });
  await window.loadURL(origin);
  let childView;
  function ObservedView(options) {
    childView = new WebContentsView(options);
    return childView;
  }
  const native = createNativeBrowser({
    browserURL,
    proxyFactory: createBrowserProxy,
    ...(process.argv.includes("--shared")
      ? {
          connectAgent: (details) => {
            const agent = makePageAgent({
              ...details,
              forbiddenPorts: [
                ...details.forbiddenPorts,
                Number(new URL(process.env.FLEET_SHARED_TEST_ORIGIN).port),
              ],
              browserURL,
              validateAction,
            });
            const disconnect = connectAgent({
              ...details,
              origin: process.env.FLEET_SHARED_TEST_ORIGIN,
              execute: (input) => agent.execute(input),
            });
            return async () => {
              agent.close();
              await disconnect();
            };
          },
        }
      : {}),
    window,
    origin,
    WebContentsView: ObservedView,
    session,
    validateProject: async (id) => id === "trial",
  });
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  let id, lease, disconnectLauncher;
  ipcMain.handle("fleet:native-browser", async (event, input) => {
    const result = await native.handle(event, input);
    if (input.action === "start") id = result.id;
    return result;
  });
  const action = (action, extra = {}) =>
    native.handle(event, { action, id, ...extra });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Native trial timed out");
  };
  try {
    if (process.argv.includes("--auto-open")) {
      assert.ok(
        process.argv.includes("--shared") && process.argv.includes("--ui"),
      );
      let connected = false;
      disconnectLauncher = connectAgent({
        origin: process.env.FLEET_SHARED_TEST_ORIGIN,
        nativeId: randomUUID(),
        registration: "launcher-register",
        onStatus: (status) => {
          connected = status.connected;
        },
        execute: async (input) => {
          // Include the isolated daemon in the fixture's forbidden ports too.
          if (input.url !== undefined)
            browserURL(input.url, [
              Number(new URL(process.env.FLEET_SHARED_TEST_ORIGIN).port),
            ]);
          const result = await native.openForAgent(input);
          id = result.id;
          window.webContents.send("fleet:browser-requested", {
            ...input,
            id: randomUUID(),
          });
          return { opened: true };
        },
      });
      await waitFor(() => connected);
    }
    if (process.argv.includes("--ui")) {
      await window.loadURL(
        process.argv.includes("--full-app")
          ? origin
          : origin +
              "/tests/fixtures/native-browser.html?url=" +
              encodeURIComponent(pageURL),
      );
      await waitFor(() =>
        window.webContents.executeJavaScript(
          process.argv.includes("--full-app")
            ? "Boolean(document.querySelector('.home-page')) || document.body.textContent.includes('Your workspace')"
            : "Boolean(document.querySelector('button[type=submit]'))",
        ),
      );
      assert.equal(
        childView,
        undefined,
        "React must not auto-start the native view",
      );
      if (process.argv.includes("--auto-open")) {
        const { withNativeBrowserTool } =
          await import("./native-shared-checks.mjs");
        await withNativeBrowserTool(async (call) => {
          await call({ action: "navigate", url: pageURL });
          assert.equal(childView.webContents.getURL(), pageURL + "/");
        });
        console.log(
          "PASS: cold stdio MCP navigate creates the native browser and reveals the React panel without a user click.",
        );
      } else {
        await window.webContents.executeJavaScript(
          "document.querySelector('button[type=submit]').click()",
        );
      }
      await waitFor(() => childView?.getVisible());
      await waitFor(() =>
        childView.webContents.executeJavaScript(
          "Boolean(document.querySelector('input'))",
        ),
      );
      assert.equal(
        await childView.webContents.executeJavaScript(
          "typeof window.fleetDesktop",
        ),
        "undefined",
      );
      const before = childView.getBounds();
      if (process.argv.includes("--full-app")) {
        console.log(
          await window.webContents.executeJavaScript(
            `JSON.stringify({viewport:innerHeight,rects:Object.fromEntries(['.workspace-content','.run-detail','.session-panes','.tool-pane','.tool-scroll','.native-browser-surface'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,{top:r.top,bottom:r.bottom,height:r.height}]}))})`,
          ),
        );
        await writeFile(
          join(directory, "full-app-layout.png"),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      assert.ok(
        Math.abs(before.y + before.height - window.getContentSize()[1]) <= 1,
        "Native browser must reach the bottom of the window",
      );
      if (process.argv.includes("--shared")) {
        const { checkNativeSharing } =
          await import("./native-shared-checks.mjs");
        await checkNativeSharing({
          web: childView.webContents,
          action,
          pageURL,
          waitFor,
        });
      }
      if (process.argv.includes("--full-app")) {
        window.setContentSize(1600, 1400);
        await waitFor(() => {
          const bounds = childView.getBounds();
          return (
            bounds.height > 850 &&
            Math.abs(bounds.y + bounds.height - window.getContentSize()[1]) <=
              1 &&
            childView.getVisible()
          );
        });
        console.log(
          "PASS: full Fleet browser fills a tall window beyond the former 850px cap.",
        );
        await writeFile(
          join(directory, "full-app-tall.png"),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      window.setSize(1100, 760);
      await waitFor(
        () =>
          childView.getBounds().width !== before.width &&
          childView.getVisible(),
      );
      await waitFor(() => {
        const bounds = childView.getBounds();
        return (
          Math.abs(bounds.y + bounds.height - window.getContentSize()[1]) <= 1
        );
      });
      await window.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Close browser').click()",
      );
      await waitFor(() => !childView.getVisible());
      const pageContents = childView.webContents;
      await window.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Confirm close').click()",
      );
      await waitFor(() => pageContents.isDestroyed());
      await waitFor(() =>
        window.webContents.executeJavaScript(
          "Boolean(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Open browser'))",
        ),
      );
      assert.equal(
        await window.webContents.executeJavaScript(
          "Boolean(document.querySelector('img[alt=\"Live project browser page\"]'))",
        ),
        false,
        "closing must return to native setup, not a streamed fallback",
      );
      if (process.argv.includes("--full-app")) {
        // Exercise both shared layouts, including the Windows title-bar inset,
        // without touching the user's running Fleet app or personal profile.
        for (const platform of ["mac", "windows"]) {
          await window.webContents.executeJavaScript(
            `document.documentElement.classList.toggle('windows-desktop', ${platform === "windows"})`,
          );
          for (const [width, height] of [
            [1600, 1000],
            [2048, 1100],
            [1000, 760],
          ]) {
            window.setContentSize(width, height);
            await waitFor(() =>
              window.webContents.executeJavaScript(`
              innerWidth === ${width} && innerHeight === ${height}
            `),
            );
            // Wait for style/layout and paint before measuring and capturing.
            await window.webContents.executeJavaScript(
              "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            );
            const layout = await window.webContents.executeJavaScript(`(() => {
              const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width}; };
              return {chat:rect('.conversation-pane'), pane:rect('.tool-pane'), form:rect('.browser-start'), button:rect('.browser-open'), buttonBackground:getComputedStyle(document.querySelector('.browser-open')).backgroundColor, headers:document.querySelectorAll('.tool-pane header').length, overflow:document.documentElement.scrollWidth > innerWidth};
            })()`);
            assert.equal(layout.headers, 1, "only one browser header");
            assert.equal(layout.overflow, false, "no horizontal page overflow");
            assert.ok(
              layout.form.width <= (width > 1100 ? 440 : 600),
              "compact start form on large screens",
            );
            assert.equal(
              layout.buttonBackground,
              "rgb(197, 164, 126)",
              "primary action has a visible filled background",
            );
            assert.ok(
              layout.button.bottom <= height,
              "primary action remains visible",
            );
            assert.ok(
              layout.form.left >= layout.pane.left &&
                layout.form.right <= layout.pane.right,
              "form fits the browser pane",
            );
            if (width > 1100) {
              assert.ok(
                layout.chat.width >= 360 && layout.chat.width <= 560,
                "readable chat column",
              );
              assert.ok(
                Math.abs(layout.chat.right - layout.pane.left) <= 1,
                "panes meet without a gutter",
              );
            } else {
              assert.ok(
                Math.abs(layout.chat.bottom - layout.pane.top) <= 1,
                "small windows stack the panes",
              );
            }
            await writeFile(
              join(directory, `browser-start-${platform}-${width}.png`),
              (await window.webContents.capturePage()).toPNG(),
            );
          }
        }
        console.log(
          "PASS: browser start layout at wide, large and stacked sizes, including Windows title-bar CSS.",
        );
      }
      console.log(
        "PASS: real Fleet preload + React UI opens a visible native child, tracks resize, hides for close confirmation and destroys only its own session.",
      );
    } else {
      await assert.rejects(
        native.handle(
          { sender: null, senderFrame: null },
          { action: "start", projectId: "trial", approved: true, url: pageURL },
        ),
        /Untrusted/,
      );
      ({ id } = await action("start", {
        projectId: "trial",
        approved: true,
        url: pageURL,
      }));
      const bounds = { x: 12, y: 55, width: 1240, height: 800 };
      await action("layout", { visible: true, bounds });
      lease = setInterval(
        () => action("layout", { visible: true, bounds }).catch(() => {}),
        500,
      );
      const web = childView.webContents;
      await waitFor(
        async () =>
          !web.isLoading() &&
          (await web.executeJavaScript(
            "Boolean(document.querySelector('input'))",
          )),
      );
      assert.equal(
        await web.executeJavaScript(
          "typeof window.fleetDesktop + ':' + typeof require + ':' + typeof process",
        ),
        "undefined:undefined:undefined",
      );
      await assert.rejects(action("navigate", { url: origin }), /internal/);
      await assert.rejects(
        action("navigate", { url: "file:///etc/passwd" }),
        /HTTP/,
      );
      web.sendInputEvent({
        type: "mouseDown",
        x: 55,
        y: 105,
        button: "left",
        clickCount: 1,
      });
      web.sendInputEvent({
        type: "mouseUp",
        x: 55,
        y: 105,
        button: "left",
        clickCount: 1,
      });
      // Focus via DOM only in this owned test fixture; text itself uses native input.
      await web.executeJavaScript("document.querySelector('input').focus()");
      await web.insertText("Native input passed");
      assert.equal(
        await web.executeJavaScript(
          "document.querySelector('output').textContent",
        ),
        "Native input passed",
      );
      window.focus();
      web.focus();
      await waitFor(() => window.isFocused() && web.isFocused());
      web.sendInputEvent({
        type: "mouseWheel",
        x: 500,
        y: 500,
        deltaX: 0,
        deltaY: -250,
        hasPreciseScrollingDeltas: true,
      });
      await waitFor(async () => await web.executeJavaScript("scrollY>0"));
      app.on("browser-window-created", () => popupWindows++);
      await web.executeJavaScript("document.querySelector('button').click()");
      await action("navigate", { url: pageURL + "/next" });
      await waitFor(() => web.getURL().endsWith("/next") && !web.isLoading());
      await action("back");
      await waitFor(() => web.getURL() === pageURL + "/" && !web.isLoading());
      assert.equal(
        internalHits,
        0,
        "private-network fetch must not reach the listener",
      );
      assert.equal(popupWindows, 0, "page popup must not open a native window");
      await web.executeJavaScript(`(async () => {
        for (let i = 0; i < 2; i++) await (await fetch('/cached-asset')).text();
      })()`);
      assert.equal(
        assetHits,
        1,
        "cacheable resources should be reused within the temporary session",
      );
      await action("layout", {
        visible: true,
        bounds: { x: 12, y: 55, width: 600, height: 500 },
      });
      assert.deepEqual(childView.getBounds(), {
        x: 12,
        y: 55,
        width: 600,
        height: 500,
      });
      console.log(
        "PASS: direct native input/scroll, navigation/back, resize, no preload/Node in pages, blocked file/internal navigation, blocked private HTTP and popups.",
      );
      if (process.argv.includes("--public")) {
        await action("navigate", { url: "https://www.shopify.com" });
        await waitFor(
          async () =>
            !web.isLoading() &&
            (await web.executeJavaScript(
              "Array.from(document.querySelectorAll('video')).some(v=>!v.paused&&v.readyState===4&&v.currentTime>1)",
            )),
        );
        const sample =
          "Array.from(document.querySelectorAll('video')).filter(v=>!v.paused&&v.readyState===4).map(v=>({time:v.currentTime,width:v.videoWidth,height:v.videoHeight,total:v.getVideoPlaybackQuality().totalVideoFrames,dropped:v.getVideoPlaybackQuality().droppedVideoFrames}))";
        const before = await web.executeJavaScript(sample);
        await new Promise((r) => setTimeout(r, 8000));
        const after = await web.executeJavaScript(sample);
        if (process.argv.includes("--scroll-profile")) {
          const { profileNativeScroll } =
            await import("./native-scroll-profile.mjs");
          await profileNativeScroll(web, window, app);
          if (process.argv.includes("--repeat-scroll")) {
            console.log(
              "Repeating the same sections after assets and animations have warmed.",
            );
            await profileNativeScroll(web, window, app);
          }
        }
        const screen = await web.capturePage();
        await writeFile(join(directory, "native-shopify.png"), screen.toPNG());
        console.log(
          JSON.stringify({
            before,
            after,
            pixels: screen.getSize(),
            screenshot: join(directory, "native-shopify.png"),
            jpegStream: false,
          }),
        );
      }
      if (process.argv.includes("--shared")) {
        const { checkNativeSharing } =
          await import("./native-shared-checks.mjs");
        await checkNativeSharing({ web, action, pageURL, waitFor });
      }
      const partition = web.session;
      assert.equal(
        partition.storagePath,
        null,
        "preview session must stay in memory",
      );
      await partition.cookies.set({
        url: pageURL,
        name: "trial",
        value: "isolated",
      });
      await action("close");
      assert.equal(web.isDestroyed(), true);
      assert.equal((await partition.cookies.get({})).length, 0);
      assert.equal(
        await partition.getCacheSize(),
        0,
        "close must clear the HTTP cache too",
      );
      console.log(
        "PASS: native preview teardown destroys the page and clears its cookies.",
      );
    }
  } catch (e) {
    if (process.argv.includes("--full-app"))
      console.log(
        JSON.stringify({
          content: window.getContentSize(),
          native: childView?.getBounds(),
          visible: childView?.getVisible(),
          dom: await window.webContents.executeJavaScript(
            `({height:innerHeight,width:innerWidth,rects:Object.fromEntries(['.tool-pane','.tool-scroll','.native-browser-surface'].map(s=>{const el=document.querySelector(s),r=el?.getBoundingClientRect();return [s,r?{top:r.top,bottom:r.bottom,height:r.height,inline:el.style.height}:null]}))})`,
          ),
        }),
      );
    if (process.argv.includes("--full-app"))
      await writeFile(
        join(directory, "full-app-failure.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    console.error(e);
    process.exitCode = 1;
  } finally {
    clearInterval(lease);
    await disconnectLauncher?.();
    await native.close();
    window.destroy();
    await Promise.all(
      [page, internal, shell].map(
        (server) => new Promise((r) => server.close(r)),
      ),
    );
    console.log("Retained isolated native trial: " + directory);
    app.exit(process.exitCode || 0);
  }
}
