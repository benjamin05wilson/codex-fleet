// Keep an owned PID alive until the supervisor has killed all its descendants.
// On Windows a shell can exit while background children are still running.
import { spawn } from "node:child_process";
import { commandInvocation } from "../shared/platform.mjs";
process.once(
  "message",
  ({ bin, args, cwd, prompt, windowsVerbatimArguments }) => {
    const command = commandInvocation(bin, args);
    const child = spawn(command.bin, command.args, {
      cwd,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: ["pipe", "inherit", "inherit"],
    });
    let reported = false;
    const report = (code) => {
      if (reported) return;
      reported = true;
      // Stay alive so taskkill can find background descendants. The outer
      // supervisor preserves the command's real exit code after cleanup.
      setInterval(() => {}, 1000);
      process.send?.({ exitCode: code });
    };
    child.on("error", (e) => {
      process.stderr.write(e.message);
      report(1);
    });
    child.on("exit", (code) => report(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  },
);
