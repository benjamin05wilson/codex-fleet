import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createNativeBrowser } from "../desktop/native-browser.mjs";
import { browserURL } from "../server/browser-network.mjs";

function fixture(t, overrides = {}) {
  const origin = "http://127.0.0.1:4317",
    views = [],
    partitions = [],
    proxies = [];
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.getContentSize = () => [1280, 880];
  window.webContents = new EventEmitter();
  window.webContents.mainFrame = { url: origin };
  window.contentView = { addChildView() {}, removeChildView() {} };
  const session = {
    fromPartition(name, options) {
      const p = new EventEmitter();
      p.name = name;
      p.options = options;
      p.setPermissionRequestHandler = (f) => (p.permission = f);
      p.setPermissionCheckHandler = (f) => (p.permissionCheck = f);
      p.webRequest = {
        onBeforeRequest(f) {
          p.request = f;
        },
      };
      p.setProxy = async (c) => (p.proxy = c);
      p.closeAllConnections = async () => (p.closed = true);
      p.clearStorageData = async () => (p.cleared = true);
      p.clearCache = async () => (p.cacheCleared = true);
      partitions.push(p);
      return p;
    },
  };
  function View(options) {
    const view = {
      options,
      visible: false,
      visibilityCalls: [],
      boundsCalls: [],
      setVisible(v) {
        this.visibilityCalls.push(v);
        this.visible = v;
      },
      setBounds(v) {
        this.boundsCalls.push(v);
        this.bounds = v;
      },
    };
    const web = new EventEmitter();
    view.webContents = web;
    web.isDestroyed = () => !!web.destroyed;
    web.getURL = () => web.url || "";
    web.getTitle = () => "Test";
    web.isLoading = () => false;
    web.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
    };
    web.close = () => (web.destroyed = true);
    web.setWindowOpenHandler = (f) => (web.popup = f);
    web.setWebRTCIPHandlingPolicy = (v) => (web.rtc = v);
    web.loadURL = async (value) => (web.url = value);
    views.push(view);
    return view;
  }
  const manager = createNativeBrowser({
    browserURL,
    window,
    origin,
    WebContentsView: View,
    session,
    proxyFactory: async (origins, forbidden) => {
      const p = {
        origins,
        forbidden,
        port: 45678,
        close: async () => (p.closed = true),
      };
      proxies.push(p);
      return p;
    },
    validateProject: async (id) => id === "project",
    ...overrides,
  });
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const start = () =>
    manager.handle(event, {
      action: "start",
      approved: true,
      projectId: "project",
      url: "https://example.com",
    });
  t.after(() => manager.close());
  return { manager, event, start, window, views, partitions, proxies };
}

test("native preview accepts only the trusted main renderer, project and explicit consent", async (t) => {
  const f = fixture(t);
  const input = {
    action: "start",
    approved: true,
    projectId: "project",
    url: "https://example.com",
  };
  for (const event of [
    { sender: null, senderFrame: f.event.senderFrame },
    { ...f.event, senderFrame: { url: "http://127.0.0.1:4317" } },
  ])
    await assert.rejects(f.manager.handle(event, input), /Untrusted/);
  f.event.senderFrame.url = "https://evil.example";
  await assert.rejects(f.manager.handle(f.event, input), /Untrusted/);
  f.event.senderFrame.url = "http://127.0.0.1:4317";
  await assert.rejects(
    f.manager.handle(f.event, { ...input, approved: false }),
    /explicitly/,
  );
  await assert.rejects(
    f.manager.handle(f.event, { ...input, projectId: "unknown" }),
    /project/,
  );
  assert.equal(f.views.length, 0);
});

test("agent opener creates and reuses the native view without loading a URL twice", async (t) => {
  const f = fixture(t, {
    connectAgent: ({ onStatus }) => {
      onStatus({ connected: true, error: "" });
      return async () => {};
    },
  });
  const input = { projectId: "project", url: "https://example.com" };
  const first = await f.manager.openForAgent(input);
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].webContents.getURL(), "");
  const restored = await f.manager.handle(f.event, {
    action: "restore",
    projectId: "project",
  });
  assert.equal(restored.id, first.id);
  const second = await f.manager.openForAgent(input);
  assert.equal(second.id, first.id);
  assert.equal(f.views.length, 1);
  await assert.rejects(
    f.manager.openForAgent({ ...input, url: "http://127.0.0.1:4317" }),
    /internal/,
  );
  await assert.rejects(
    f.manager.openForAgent({ ...input, url: "file:///etc/passwd" }),
    /HTTP/,
  );
  await assert.rejects(
    f.manager.openForAgent({ ...input, projectId: "unknown" }),
    /project/,
  );
  assert.equal(f.views.length, 1);
});

test("native view uses a fresh protected session and exposes no preload or agent channel", async (t) => {
  const f = fixture(t),
    { id } = await f.start(),
    view = f.views[0],
    p = f.partitions[0],
    web = view.webContents;
  assert.equal(p.name.startsWith("persist:"), false);
  assert.equal(p.options.cache, true);
  assert.equal(p.proxy.proxyBypassRules, "<-loopback>");
  assert.deepEqual(f.proxies[0].origins, []);
  assert.deepEqual(view.options.webPreferences, {
    session: p,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    disableDialogs: true,
    spellcheck: false,
  });
  let permission;
  p.permission(null, "media", (v) => (permission = v));
  assert.equal(permission, false);
  assert.equal(p.permissionCheck(), false);
  assert.equal(web.rtc, "disable_non_proxied_udp");
  assert.deepEqual(web.popup(), { action: "deny" });
  for (const url of [
    "file:///etc/passwd",
    "http://127.0.0.1:4317/api/state",
    "http://127.0.0.1:45678",
    "javascript:alert(1)",
  ]) {
    let cancel;
    p.request({ url }, (v) => (cancel = v.cancel));
    assert.equal(cancel, true, url);
    await assert.rejects(
      f.manager.handle(f.event, { action: "navigate", id, url }),
    );
  }
  let download = false;
  p.emit("will-download", {
    preventDefault() {
      download = true;
    },
  });
  assert.ok(download);
  let nav = false;
  web.emit("will-frame-navigate", {
    url: "file:///etc/passwd",
    preventDefault() {
      nav = true;
    },
  });
  assert.ok(nav);
  await assert.rejects(
    f.manager.handle(f.event, { action: "eval", id, source: "evil" }),
    /Unsupported/,
  );
  await assert.rejects(
    f.manager.handle(f.event, { action: "state", id: "other" }),
    /not open/,
  );
  await assert.rejects(f.start(), /existing/);
});

test("native surface bounds are constrained, visibility lease expires, and close clears the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t),
    { id } = await f.start(),
    view = f.views[0];
  const input = {
    action: "layout",
    id,
    visible: true,
    bounds: { x: 10, y: 60, width: 900, height: 700 },
  };
  await f.manager.handle(f.event, input);
  assert.equal(view.visible, true);
  for (const bounds of [
    { x: -1, y: 0, width: 900, height: 700 },
    { x: 0, y: 0, width: 2000, height: 900 },
    { x: 0, y: 0, width: NaN, height: 800 },
  ])
    await assert.rejects(
      f.manager.handle(f.event, { ...input, bounds }),
      /bounds/,
    );
  t.mock.timers.tick(1800);
  assert.equal(view.visible, false);
  await f.manager.handle(f.event, input);
  f.window.webContents.emit("did-start-navigation");
  assert.equal(view.visible, false);
  await f.manager.handle(f.event, { action: "close", id });
  assert.equal(view.webContents.destroyed, true);
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.partitions[0].cleared, true);
  assert.equal(f.partitions[0].cacheCleared, true);
  await f.start();
  assert.notEqual(f.partitions[0].name, f.partitions[1].name);
});

test("layout heartbeats do not resize or re-show an unchanged native surface, but still renew its safety lease", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t),
    { id } = await f.start(),
    view = f.views[0];
  const input = {
    action: "layout",
    id,
    visible: true,
    bounds: { x: 10, y: 60, width: 900, height: 700 },
  };
  for (let i = 0; i < 20; i++) {
    await f.manager.handle(f.event, input);
    t.mock.timers.tick(500);
  }
  assert.deepEqual(view.boundsCalls, [input.bounds]);
  assert.deepEqual(view.visibilityCalls, [false, true]);
  assert.equal(view.visible, true, "heartbeats must keep the surface visible");
  await f.manager.handle(f.event, {
    ...input,
    bounds: { ...input.bounds, width: 901 },
  });
  assert.equal(view.boundsCalls.length, 2);
  assert.equal(view.visibilityCalls.length, 2);
  t.mock.timers.tick(1800);
  assert.equal(
    view.visible,
    false,
    "loss of heartbeat must still hide the view",
  );
  await f.manager.handle(f.event, {
    ...input,
    bounds: { ...input.bounds, width: 901 },
  });
  assert.equal(
    view.boundsCalls.length,
    2,
    "showing a hidden view doesn't require resizing it",
  );
  assert.deepEqual(view.visibilityCalls, [false, true, false, true]);
});

test("concurrent starts and window closure during opening cannot leave an orphan view", async (t) => {
  let resolve;
  const f = fixture(t, {
    validateProject: () => new Promise((r) => (resolve = r)),
  });
  const pending = f.start();
  await assert.rejects(f.start(), /existing/);
  await f.manager.close();
  resolve(true);
  await assert.rejects(pending, /closed/);
  assert.equal(f.views.length, 0);
  assert.equal(f.proxies[0].closed, true);
  assert.equal(f.partitions[0].cleared, true);
  assert.equal(f.partitions[0].cacheCleared, true);
});

test("same-project restore retains the native page, while changing projects closes only the previous page", async (t) => {
  const f = fixture(t, {
    validateProject: async (id) => ["project", "second"].includes(id),
  });
  const started = await f.start();
  assert.equal(
    (
      await f.manager.handle(f.event, {
        action: "restore",
        projectId: "project",
      })
    ).id,
    started.id,
  );
  assert.equal(f.views[0].webContents.destroyed, undefined);
  assert.equal(
    await f.manager.handle(f.event, { action: "restore", projectId: "second" }),
    null,
  );
  assert.equal(f.views[0].webContents.destroyed, true);
  assert.equal(f.partitions[0].cacheCleared, true);
});

test("late restore from an unmounted project cannot close the newly selected project's browser", async (t) => {
  const waits = [];
  let deferred = false;
  const f = fixture(t, {
    validateProject: () =>
      deferred
        ? new Promise((resolve) => waits.push(resolve))
        : Promise.resolve(true),
  });
  await f.start();
  deferred = true;
  const old = f.manager.handle(f.event, {
    action: "restore",
    projectId: "project",
  });
  const recent = f.manager.handle(f.event, {
    action: "restore",
    projectId: "second",
  });
  waits[1](true);
  await recent;
  deferred = false;
  const opened = await f.manager.handle(f.event, {
    action: "start",
    projectId: "second",
    url: "https://example.com",
    approved: true,
  });
  waits[0](true);
  assert.equal(await old, null);
  assert.equal(
    (
      await f.manager.handle(f.event, {
        action: "restore",
        projectId: "second",
      })
    ).id,
    opened.id,
  );
  assert.equal(f.views[1].webContents.destroyed, undefined);
});
