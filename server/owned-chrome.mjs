import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  createReadStream,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { unlink, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { connectChromePages } from "./chrome-pages.mjs";
import { createBackgroundGate } from "./chrome-background-gate.mjs";
const exec = promisify(execFile);

const executable =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const ownedChromeAvailable = () =>
  process.platform === "darwin" && existsSync(executable);

// Only launch a fresh Fleet-owned profile. Never discover, attach to, or close
// the user's existing Chrome. Bind to the endpoint reported by THIS child,
// not whichever browser happens to answer on a debugging port.
export async function launchOwnedChrome({
  directory,
  proxyPort,
  excludedPorts = [],
  onExit = () => {},
  background = false,
}) {
  if (!ownedChromeAvailable())
    throw new Error(
      "Full Chrome requires Google Chrome in /Applications on macOS.",
    );
  let port;
  for (let attempt = 0; attempt < 12; attempt++) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const candidate = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    if (![proxyPort, ...excludedPorts].includes(candidate)) {
      port = candidate;
      break;
    }
  }
  if (!port)
    throw new Error("Could not reserve a private Chrome debugging port.");
  const env = Object.fromEntries(
    ["HOME", "USER", "PATH", "TMPDIR"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  const args = [
    `--user-data-dir=${join(directory, "chrome-profile")}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run",
    "--no-default-browser-check",
    ...(background ? ["--no-startup-window"] : ["--new-window", "about:blank"]),
  ];
  // LaunchServices can refuse a stdio FIFO under a privacy-protected folder
  // (e.g. Desktop), even though Chrome can use its profile there. Keep only
  // this ephemeral transport in the OS temp directory, never the user profile.
  const pipeDirectory = background
    ? await mkdtemp(join(tmpdir(), "fleet-chrome-io-"))
    : null;
  const pipe = join(pipeDirectory || directory, "chrome-stderr.pipe");
  if (background) await exec("/usr/bin/mkfifo", ["-m", "600", pipe]);
  // Keep FIFO open non-blockingly until Chrome has its own writer. Without
  // this guard, a failed LaunchServices start can strand a filesystem worker
  // inside open(2), even after the read stream is destroyed.
  let guard = background
    ? openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK)
    : null;
  const releaseGuard = () => {
    if (guard !== null) {
      closeSync(guard);
      guard = null;
    }
  };
  const stderr = background ? createReadStream(pipe) : null;
  const child = spawn(
    background ? "/usr/bin/open" : executable,
    background
      ? [
          "-n",
          "-g",
          "-W",
          "-a",
          "/Applications/Google Chrome.app",
          "--stderr",
          pipe,
          "--args",
          ...args,
        ]
      : args,
    { stdio: ["ignore", "ignore", "pipe"], env },
  );
  const output = stderr || child.stderr;
  output.on("error", () => {
    if (!closing) onExit();
  });
  let launchStatus;
  if (background)
    child.stderr.on("data", (chunk) => {
      // Retain only an OS status code, never arbitrary Chrome/page log content.
      const match = chunk.toString().match(/with error (-?\d+)/);
      if (match) launchStatus = Number(match[1]);
    });
  let exited = false,
    closing = false,
    failure;
  let pages, chromePid, gate;
  let resolveExit;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.once("exit", () => {
    exited = true;
    resolveExit();
    if (!closing) onExit();
  });
  child.on("error", (error) => {
    failure = error;
    exited = true;
    resolveExit();
  });
  const close = async () => {
    closing = true;
    releaseGuard();
    await gate?.close();
    pages?.close();
    if (exited) {
      stderr?.destroy();
      if (background) await unlink(pipe).catch(() => {});
      if (pipeDirectory) await rmdir(pipeDirectory).catch(() => {});
      return;
    }
    if (background && !chromePid) {
      // Failure-only cleanup: match this newly generated profile exactly, not
      // personal Chrome or arbitrary debug ports. Never print process arguments.
      const { stdout } = await exec("/bin/ps", ["-axo", "pid=,command="]);
      const profile = `--user-data-dir=${join(directory, "chrome-profile")}`;
      const rows = stdout
        .split("\n")
        .filter(
          (row) =>
            row.includes(executable) &&
            (row.includes(profile + " ") || row.endsWith(profile)) &&
            !row.includes("--type="),
        );
      if (rows.length === 1) chromePid = Number(rows[0].trim().split(/\s+/)[0]);
    }
    const terminate = (signal) => {
      if (chromePid) {
        try {
          process.kill(chromePid, signal);
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      } else child.kill(signal);
    };
    terminate("SIGTERM");
    let timer;
    await Promise.race([
      exit,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) {
      terminate("SIGKILL");
      child.kill("SIGTERM");
      await exit;
    }
    stderr?.destroy();
    if (background) await unlink(pipe).catch(() => {});
    if (pipeDirectory) await rmdir(pipeDirectory).catch(() => {});
  };
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(
        () =>
          finish(
            new Error("Chrome did not expose its owned debugging endpoint."),
          ),
        10000,
      );
      const finish = (error, value) => {
        clearTimeout(timeout);
        output.off("data", data);
        output.off("error", failed);
        child.off("exit", ended);
        child.off("error", failed);
        error ? reject(error) : resolve(value);
      };
      const ended = () =>
        finish(
          new Error(
            launchStatus
              ? `macOS could not launch Chrome (status ${launchStatus}).`
              : "Chrome closed before attachment was ready.",
          ),
        );
      const failed = () =>
        finish(new Error("Could not start the owned Chrome process."));
      const data = (chunk) => {
        buffer = (buffer + chunk.toString()).slice(-16000);
        const match = buffer.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)/,
        );
        if (match && Number(new URL(match[1]).port) === port)
          finish(null, match[1]);
      };
      output.on("data", data);
      output.once("error", failed);
      child.once("exit", ended);
      child.once("error", failed);
      if (failure || exited) failed();
    });
    // Continue draining stderr without retaining Chrome logs or page data.
    releaseGuard();
    output.resume();
    if (exited) throw new Error("Chrome closed before attachment was ready.");
    if (background) {
      pages = await connectChromePages(endpoint);
      chromePid = await pages.processId();
      await pages.createTab("about:blank");
      gate = await createBackgroundGate(endpoint, (target) =>
        pages.bind(target, 1280, 800),
      );
    }
    return {
      endpoint: gate?.endpoint || endpoint,
      port,
      gatePort: gate?.port,
      background,
      pages,
      alive: () => !exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
