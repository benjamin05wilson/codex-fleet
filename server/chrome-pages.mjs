// Private control channel for Fleet-owned, windowless tabs in FULL Chrome.
import { WebSocket } from "ws";
// Never exposed to renderer/agent; public actions still pass Fleet's ownership,
// network and approval checks. The Rust controller continues to handle agent tools.
export async function connectChromePages(endpoint) {
  const socket = new WebSocket(endpoint, { maxPayload: 8000000 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome connection timed out."));
    }, 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Chrome connection failed."));
    };
  });
  let sequence = 0,
    active,
    activeTarget,
    closed = false;
  const pending = new Map(),
    sessions = new Map(),
    mainFrames = new Map();
  let frameListener,
    frameError,
    navigationListener,
    frameSequence = 0,
    captureSession,
    captureSize,
    captureWidth = 1280,
    captureHeight = 800;
  let binding = Promise.resolve();
  const enqueueBinding = (operation) => {
    const task = binding.then(operation);
    binding = task.catch(() => {});
    return task;
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error("Chrome connection closed."));
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  socket.onmessage = ({ data }) => {
    let value;
    try {
      value = JSON.parse(String(data));
    } catch {
      return;
    }
    if (value.method === "Page.screencastFrame") {
      // Acknowledge stale-tab frames too, but never paint them after a switch.
      const frame = value.params;
      if (
        !Number.isInteger(frame?.sessionId) ||
        typeof value.sessionId !== "string"
      )
        return;
      call(
        "Page.screencastFrameAck",
        { sessionId: frame.sessionId },
        value.sessionId,
      ).catch(() => {});
      const metadata = frame.metadata;
      if (
        value.sessionId === active &&
        frameListener &&
        typeof frame.data === "string" &&
        frame.data.length > 0 &&
        frame.data.length < 1800000 &&
        Number.isFinite(metadata?.deviceWidth) &&
        metadata.deviceWidth > 0 &&
        Number.isFinite(metadata.deviceHeight) &&
        metadata.deviceHeight > 0
      )
        frameListener({ ...frame, seq: ++frameSequence });
      return;
    }
    if (value.sessionId === active) {
      if (
        value.method === "Page.frameNavigated" &&
        !value.params?.frame?.parentId &&
        typeof value.params?.frame?.url === "string"
      ) {
        mainFrames.set(active, value.params.frame.id);
        navigationListener?.({ url: value.params.frame.url, clear: true });
      }
      if (
        value.method === "Page.navigatedWithinDocument" &&
        value.params?.frameId &&
        value.params.frameId === mainFrames.get(active) &&
        typeof value.params?.url === "string"
      )
        navigationListener?.({ url: value.params.url, clear: false });
    }
    if (value.method === "Target.detachedFromTarget") {
      const sessionId = value.params?.sessionId;
      mainFrames.delete(sessionId);
      for (const [target, session] of sessions)
        if (session === sessionId) sessions.delete(target);
      if (sessionId && sessionId === active) {
        active = activeTarget = captureSession = undefined;
        frameError?.();
      }
      return;
    }
    const p = pending.get(value.id);
    if (!p) return;
    pending.delete(value.id);
    clearTimeout(p.timer);
    value.error
      ? p.reject(new Error(value.error.message))
      : p.resolve(value.result);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Chrome connection closed."));
    }
    pending.clear();
    socket.close();
    frameError?.();
  };
  socket.onerror = close;
  socket.onclose = close;
  const capture = async () => {
    if (!frameListener || !active) return;
    const size = `${captureWidth}x${captureHeight}`;
    if (captureSession === active && captureSize === size) return;
    if (captureSession)
      await call("Page.stopScreencast", {}, captureSession).catch(() => {});
    await call(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: 80,
        maxWidth: captureWidth,
        maxHeight: captureHeight,
        everyNthFrame: 1,
      },
      active,
    );
    captureSession = active;
    captureSize = size;
  };
  const bind = (targetId, width, height) =>
    enqueueBinding(async () => {
      let sessionId = sessions.get(targetId);
      if (!sessionId) {
        ({ sessionId } = await call("Target.attachToTarget", {
          targetId,
          flatten: true,
        }));
        sessions.set(targetId, sessionId);
        await call("Page.enable", {}, sessionId);
        const tree = await call("Page.getFrameTree", {}, sessionId);
        mainFrames.set(sessionId, tree?.frameTree?.frame?.id);
        await call(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          sessionId,
        );
      }
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      const switched = active !== sessionId;
      active = sessionId;
      activeTarget = targetId;
      if (switched) navigationListener?.({ clear: true });
      captureWidth = width;
      captureHeight = height;
      await capture();
    });
  return {
    close,
    bind,
    startFrames(listener, onError, onNavigate) {
      return enqueueBinding(async () => {
        frameListener = listener;
        frameError = onError;
        navigationListener = onNavigate;
        await capture();
      });
    },
    async url() {
      return (await call("Target.getTargetInfo", { targetId: activeTarget }))
        .targetInfo.url;
    },
    async processId() {
      const result = await call("SystemInfo.getProcessInfo");
      const pid = result.processInfo.find((p) => p.type === "browser")?.id;
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error("Owned Chrome process unavailable.");
      return pid;
    },
    async createTab(url, width = 1280, height = 800) {
      const { targetId } = await call("Target.createTarget", {
        url,
        hidden: true,
        background: true,
      });
      await bind(targetId, width, height);
      return targetId;
    },
    async input(input, width, height) {
      if (!active) throw new Error("Browser tab is not ready.");
      if (input.action === "type")
        return call("Input.insertText", { text: input.text }, active);
      if (input.action === "press") {
        const codes = {
          Enter: 13,
          Tab: 9,
          Escape: 27,
          Backspace: 8,
          Delete: 46,
          ArrowUp: 38,
          ArrowDown: 40,
          ArrowLeft: 37,
          ArrowRight: 39,
          Home: 36,
          End: 35,
          PageUp: 33,
          PageDown: 34,
          Space: 32,
        };
        const selectAll = ["Meta+a", "Control+a"].includes(input.text);
        const key = input.text === "Space" ? " " : selectAll ? "a" : input.text;
        const code = selectAll ? 65 : codes[input.text];
        if (!code) throw new Error("Unsupported browser key.");
        const params = {
          key,
          code: selectAll ? "KeyA" : input.text,
          windowsVirtualKeyCode: code,
          modifiers:
            input.text === "Meta+a" ? 4 : input.text === "Control+a" ? 2 : 0,
        };
        await call(
          "Input.dispatchKeyEvent",
          {
            type: "keyDown",
            ...params,
            ...(selectAll
              ? { commands: ["selectAll"] }
              : key === "Enter"
                ? { text: "\r" }
                : key === " "
                  ? { text: " " }
                  : {}),
          },
          active,
        );
        return call(
          "Input.dispatchKeyEvent",
          { type: "keyUp", ...params },
          active,
        );
      }
      if (input.action === "clickPoint") {
        const point = { x: input.x, y: input.y, button: "left", clickCount: 1 };
        await call(
          "Input.dispatchMouseEvent",
          { type: "mousePressed", ...point },
          active,
        );
        return call(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...point },
          active,
        );
      }
      if (input.action === "wheel")
        return call(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: width / 2,
            y: height / 2,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          },
          active,
        );
      throw new Error("Unsupported direct input.");
    },
    // Read-only diagnostic: hidden pages must never gain a native window.
    async hasWindow() {
      const { targetInfos } = await call("Target.getTargets");
      for (const { targetId } of targetInfos.filter(
        (target) => target.type === "page",
      )) {
        try {
          await call("Browser.getWindowForTarget", { targetId });
          return true;
        } catch (e) {
          if (!/window not found/i.test(e.message)) throw e;
        }
      }
      return false;
    },
  };
}
