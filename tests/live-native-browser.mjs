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
if (!process.argv.includes("--run")) {
  console.log(
    "Use --run for an isolated native desktop browser trial; --public adds Shopify.",
  );
} else if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
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
  const origin = `http://127.0.0.1:${shell.address().port}`,
    pageURL = `http://127.0.0.1:${page.address().port}`;
  const window = new BrowserWindow({
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
  let id, lease;
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
    if (process.argv.includes("--ui")) {
      await window.loadURL(
        origin +
          "/tests/fixtures/native-browser.html?url=" +
          encodeURIComponent(pageURL),
      );
      await waitFor(() =>
        window.webContents.executeJavaScript(
          "Boolean(document.querySelector('button[type=submit]'))",
        ),
      );
      assert.equal(
        childView,
        undefined,
        "React must not auto-start the native view",
      );
      await window.webContents.executeJavaScript(
        "document.querySelector('button[type=submit]').click()",
      );
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
      window.setSize(1100, 760);
      await waitFor(
        () =>
          childView.getBounds().width < before.width && childView.getVisible(),
      );
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
    console.error(e);
    process.exitCode = 1;
  } finally {
    clearInterval(lease);
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
