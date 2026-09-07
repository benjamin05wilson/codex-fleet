import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const env = { ...process.env, FLEET_DESKTOP_TRIAL: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)("electron"), ["."], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
