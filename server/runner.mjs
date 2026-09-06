// Child supervisor: losing the daemon IPC connection terminates this owned process group.
import { spawn } from "node:child_process";
let child;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) process.exit(0);
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
process.once("message", ({ bin, args, cwd, prompt }) => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
  };
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", (e) => {
    process.stderr.write(e.message);
    process.exitCode = 1;
  });
  child.on("close", (code) => process.exit(code ?? 1));
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
});
