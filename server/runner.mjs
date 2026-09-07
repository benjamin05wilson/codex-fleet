// Child supervisor: losing the daemon IPC connection terminates this owned process group.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  commandInvocation,
  processEnvironment,
  stopProcessTree,
} from "../shared/platform.mjs";
let child;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) process.exit(0);
  if (process.platform === "win32") {
    stopProcessTree({ pid: process.pid });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }, 2500).unref();
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.once(
  "message",
  ({ bin, args, cwd, prompt, windowsVerbatimArguments = false }) => {
    const env = {
      ...processEnvironment(),
      LANG: "en_US.UTF-8",
      TERM: "dumb",
    };
    const invocation = commandInvocation(bin, args);
    if (process.platform === "win32") {
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./windows-command.mjs", import.meta.url))],
        {
          cwd,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      let exitCode = 1;
      child.once("message", (result) => {
        exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
        stopProcessTree(child);
      });
      child.on("error", (e) => {
        process.stderr.write(e.message);
        process.exitCode = 1;
      });
      child.on("close", () => process.exit(exitCode));
      child.send({ bin, args, cwd, prompt, windowsVerbatimArguments });
      return;
    }
    child = spawn(invocation.bin, invocation.args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", (e) => {
      process.stderr.write(e.message);
      process.exitCode = 1;
    });
    child.on("close", (code) => process.exit(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  },
);
