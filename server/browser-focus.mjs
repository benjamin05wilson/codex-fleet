import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

// AppKit addresses a single process, never every app named Chrome. No Accessibility
// permission or personal-profile discovery is needed. Don't activate another app
// if the user changed focus while the browser command was running.
export async function foregroundPid() {
  if (process.platform !== "darwin") return null;
  const { stdout } = await exec(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;',
    ],
    { timeout: 2000 },
  );
  return Number(stdout.trim()) || null;
}
export async function backgroundChrome(pid, previous) {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0)
    return;
  await exec(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `
    ObjC.import("AppKit");
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
    if (app && !app.isTerminated && ObjC.unwrap(app.bundleIdentifier) === "com.google.Chrome") {
      const wasActive = app.isActive;
      // Keep the window rendered behind Fleet. Hiding/minimizing on macOS can
      // suspend screencast frames even with renderer throttling disabled.
      ${
        Number.isInteger(previous) && previous > 0 && previous !== pid
          ? `
      if (wasActive) {
        const prior = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${previous});
        if (prior && !prior.isTerminated) prior.activateWithOptions(0);
      }`
          : ""
      }
    }
  `,
    ],
    { timeout: 2000 },
  );
}

export async function ownedBrowserPid(endpoint) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.pathname.startsWith("/devtools/browser/")
  )
    throw new Error("Invalid owned browser endpoint.");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let finished = false;
    const finish = (error, pid) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve(pid);
    };
    const timer = setTimeout(
      () => finish(new Error("Browser process lookup timed out.")),
      2000,
    );
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ id: 1, method: "SystemInfo.getProcessInfo" }),
      );
    socket.onerror = () => finish(new Error("Browser process lookup failed."));
    socket.onclose = () => finish(new Error("Browser connection closed."));
    socket.onmessage = ({ data }) => {
      let value;
      try {
        value = JSON.parse(String(data));
      } catch {
        return finish(new Error("Invalid browser response."));
      }
      if (value.id !== 1) return;
      const pid = value.result?.processInfo?.find(
        (p) => p.type === "browser",
      )?.id;
      finish(
        Number.isInteger(pid)
          ? null
          : new Error("Browser process unavailable."),
        pid,
      );
    };
  });
}
