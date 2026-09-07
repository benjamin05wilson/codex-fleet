import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const run = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with ${code}`)),
    );
  });
if (process.platform === "darwin") {
  await run("swift", ["scripts/icon.swift", "build/fleet.iconset"]);
  await run("iconutil", [
    "-c",
    "icns",
    "build/fleet.iconset",
    "-o",
    "build/fleet.icns",
  ]);
} else if (process.platform !== "win32")
  throw new Error("Desktop packages currently target macOS and Windows.");
const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
await run(process.execPath, [
  cli,
  ...(process.platform === "win32"
    ? ["--win", "nsis", "--x64"]
    : ["--mac", "--dir"]),
  "--publish",
  "never",
]);
