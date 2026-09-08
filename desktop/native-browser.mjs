import { randomUUID } from "node:crypto";

// Desktop-only, opt-in rendering trial. Remote pages get neither a preload nor
// IPC. A main-process bridge shares only this native page with project agents.
export function createNativeBrowser({
  window,
  origin,
  WebContentsView,
  session,
  browserURL,
  proxyFactory,
  connectAgent,
  validateProject = async () => true,
}) {
  let current,
    opening = false,
    disposed = false,
    selection = 0;
  const forbidden = [4317, Number(new URL(origin).port)];
  const trusted = (event) => {
    if (
      disposed ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin
    )
      throw new Error("Untrusted native browser request.");
  };
  const get = (input) => {
    if (
      !current ||
      current.id !== input?.id ||
      current.view.webContents.isDestroyed()
    )
      throw new Error("Native preview is not open.");
    return current;
  };
  const state = (c) => ({
    id: c.id,
    url: c.view.webContents.getURL(),
    title: c.view.webContents.getTitle(),
    error: c.error || "",
    loading: c.view.webContents.isLoading(),
    canBack: c.view.webContents.navigationHistory.canGoBack(),
    canForward: c.view.webContents.navigationHistory.canGoForward(),
    agentConnected: !!c.agentConnected,
    agentError: c.agentError || "",
  });
  const visibility = (c, visible) => {
    if (c.visible === visible) return;
    c.view.setVisible(visible);
    c.visible = visible;
  };
  const hide = () => {
    if (current) visibility(current, false);
  };
  const close = async () => {
    const c = current;
    if (!c) return;
    current = null;
    if (!window.isDestroyed()) window.contentView.removeChildView(c.view);
    if (!c.view.webContents.isDestroyed())
      c.view.webContents.close({ waitForBeforeUnload: false });
    await c.disconnectAgent?.();
    await c.proxy.close();
    await c.partition.closeAllConnections();
    await Promise.all([
      c.partition.clearStorageData(),
      c.partition.clearCache(),
    ]);
  };
  const start = async (input, deferNavigation = false) => {
    if (opening || current)
      throw new Error("Close the existing native preview first.");
    selection++;
    opening = true;
    let proxy, partition, view;
    try {
      if (
        input?.approved !== true ||
        typeof input.projectId !== "string" ||
        !(await validateProject(input.projectId))
      )
        throw new Error(
          "Choose a project and explicitly open the native preview.",
        );
      const url = browserURL(input.url, forbidden);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ? [url.origin]
        : [];
      proxy = await proxyFactory(local, forbidden);
      // The unique, non-persist partition keeps the cache in memory. Disabling
      // HTTP caching needlessly downloads shared resources again on navigation.
      partition = session.fromPartition("fleet-native-" + randomUUID(), {
        cache: true,
      });
      partition.setPermissionRequestHandler((_web, _permission, callback) =>
        callback(false),
      );
      partition.setPermissionCheckHandler(() => false);
      partition.on("will-download", (event) => event.preventDefault());
      partition.webRequest.onBeforeRequest((details, callback) => {
        // Proxy pins DNS for HTTP(S)/WS(S). Never grant file://, custom schemes,
        // extension pages or access to Fleet itself, including from subframes.
        try {
          const value = details.url
            .replace(/^ws:/, "http:")
            .replace(/^wss:/, "https:");
          if (!/^(data:|blob:|about:blank$)/.test(value))
            browserURL(value, [...forbidden, proxy.port]);
          callback({ cancel: false });
        } catch {
          callback({ cancel: true });
        }
      });
      await partition.setProxy({
        mode: "fixed_servers",
        proxyRules: `http://127.0.0.1:${proxy.port}`,
        proxyBypassRules: "<-loopback>",
      });
      if (disposed) throw new Error("Fleet window closed.");
      view = new WebContentsView({
        webPreferences: {
          session: partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          webviewTag: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
          disableDialogs: true,
          spellcheck: false,
        },
      });
      const c = {
        id: randomUUID(),
        projectId: input.projectId,
        view,
        proxy,
        partition,
        error: "",
        visible: false,
      };
      current = c;
      view.setVisible(false);
      window.contentView.addChildView(view);
      const web = view.webContents;
      if (connectAgent)
        c.disconnectAgent = connectAgent({
          web,
          projectId: input.projectId,
          nativeId: c.id,
          forbiddenPorts: [...forbidden, proxy.port],
          onStatus: ({ connected, error }) => {
            c.agentConnected = connected;
            c.agentError = error;
          },
        });
      web.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      web.setWindowOpenHandler(() => {
        c.error =
          "Pop-up windows are disabled in this preview. Open the link using the address bar.";
        return { action: "deny" };
      });
      for (const event of [
        "will-navigate",
        "will-frame-navigate",
        "will-redirect",
      ])
        web.on(event, (details, target) => {
          try {
            browserURL(details.url || target, [...forbidden, proxy.port]);
          } catch {
            details.preventDefault();
            c.error = "Navigation blocked by the preview's network policy.";
          }
        });
      web.on("will-attach-webview", (event) => event.preventDefault());
      web.on("render-process-gone", () => {
        c.error = "Native renderer stopped. Close and reopen the preview.";
        hide();
      });
      web.on("did-fail-load", (_event, code, description, _url, main) => {
        if (main && code !== -3)
          c.error = `Could not load the page (${code}: ${description}).`;
      });
      // Return promptly, so renderer can place the view while navigation runs.
      if (!deferNavigation) web.loadURL(url.href).catch(() => {});
      return state(c);
    } catch (error) {
      if (current && current.view === view) await close();
      else {
        if (view && !view.webContents.isDestroyed()) view.webContents.close();
        await proxy?.close();
        await Promise.all([
          partition?.clearStorageData(),
          partition?.clearCache(),
        ]);
      }
      throw error;
    } finally {
      opening = false;
    }
  };
  window.webContents.on("did-start-navigation", hide);
  window.webContents.on("render-process-gone", hide);
  window.on("hide", hide);
  return {
    // Main-process only: the broker derives project/run from the active chat's
    // capability. This is not an IPC action that a website or model can invoke.
    async openForAgent({ projectId, url }) {
      if (url !== undefined) browserURL(url, forbidden);
      if (url === undefined && (!current || current.projectId !== projectId))
        throw new Error(
          "No open page for this project. Use navigate with a URL to open it.",
        );
      if (disposed || !(await validateProject(projectId)))
        throw new Error("Choose an existing project in Fleet Desktop.");
      if (opening)
        throw new Error("Browser is opening. Retry navigate shortly.");
      if (current && current.projectId !== projectId) await close();
      if (!current) await start({ projectId, url, approved: true }, true);
      const c = current;
      // Registration must finish before the broker dispatches the navigation.
      // Start with an empty native view, so the requested URL loads only once.
      for (let i = 0; i < 250; i++) {
        if (disposed || current !== c || c.view.webContents.isDestroyed())
          throw new Error("Browser closed while opening.");
        if (c.agentConnected) return state(c);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        c.agentError ||
          "Browser agent connection is not ready. Retry navigate.",
      );
    },
    async handle(event, input) {
      trusted(event);
      if (input?.action === "restore") {
        const revision = ++selection;
        if (
          typeof input.projectId !== "string" ||
          !(await validateProject(input.projectId))
        )
          throw new Error("Choose an existing project.");
        if (revision !== selection || disposed) return null;
        if (current && current.projectId !== input.projectId) await close();
        return current && !current.view.webContents.isDestroyed()
          ? state(current)
          : null;
      }
      if (input?.action === "start") return start(input);
      // A renderer cleanup may arrive after its close reply. Hiding an old
      // surface is harmless and must never affect a subsequently opened one.
      if (
        input?.action === "layout" &&
        input.visible === false &&
        input.id !== current?.id
      )
        return;
      const c = get(input),
        web = c.view.webContents;
      switch (input.action) {
        case "state":
          return state(c);
        case "layout": {
          const b = input.bounds,
            [width, height] = window.getContentSize();
          if (input.visible !== true) {
            hide();
            return;
          }
          if (
            !b ||
            ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
            b.x < 0 ||
            b.y < 0 ||
            b.width < 32 ||
            b.height < 32 ||
            b.x + b.width > width + 1 ||
            b.y + b.height > height + 1
          )
            throw new Error("Invalid native browser bounds.");
          const bounds = Object.fromEntries(
            Object.entries(b)
              .filter(([key]) => ["x", "y", "width", "height"].includes(key))
              .map(([key, value]) => [key, Math.round(value)]),
          );
          // Keep the compositor surface untouched unless geometry changed.
          if (
            !c.bounds ||
            Object.keys(bounds).some((key) => bounds[key] !== c.bounds[key])
          ) {
            c.view.setBounds(bounds);
            c.bounds = bounds;
          }
          visibility(c, true);
          return;
        }
        case "navigate": {
          const url = browserURL(input.url, [...forbidden, c.proxy.port]);
          c.error = "";
          web.loadURL(url.href).catch(() => {});
          return state(c);
        }
        case "back":
          if (web.navigationHistory.canGoBack()) web.navigationHistory.goBack();
          return state(c);
        case "forward":
          if (web.navigationHistory.canGoForward())
            web.navigationHistory.goForward();
          return state(c);
        case "reload":
          c.error = "";
          web.reload();
          return state(c);
        case "close":
          await close();
          return;
        default:
          throw new Error("Unsupported native browser action.");
      }
    },
    async close() {
      disposed = true;
      await close();
    },
  };
}
