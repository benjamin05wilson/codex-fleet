import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { managedTools } from "../shared/managed-tools.mjs";
import { execFileSync } from "node:child_process";
import { verifyWindowsBranding } from "./verify-windows-branding.mjs";

const root = resolve(process.argv[2] || "release/win-unpacked");
verifyWindowsBranding(join(root, "Fleet.exe"));
const exe = readFileSync(join(root, "Fleet.exe"));
assert.equal(exe.toString("ascii", 0, 2), "MZ");
assert.equal(exe.readUInt16LE(exe.readUInt32LE(0x3c) + 4), 0x8664);
const runtime = join(root, "resources", "runtime");
const require = createRequire(join(runtime, "server", "terminals.mjs"));
// Do not let a checkout's parent node_modules hide a broken standalone bundle.
assert.equal(
  require.resolve("node-pty/package.json"),
  join(runtime, "node_modules", "node-pty", "package.json"),
);
for (const file of [
  "shared/platform.mjs",
  "server/windows-command.mjs",
  "server/runner.mjs",
  "dist/index.html",
  "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
  "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node",
  "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
  "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
])
  assert(existsSync(join(runtime, file)), `Missing packaged file: ${file}`);
console.log(
  "Verified standalone Windows x64 runtime and native terminal dependencies.",
);
const tools = managedTools(join(root, "resources"), "win32", "x64");
assert(
  tools,
  "Installer must include Node, Git and Codex; no machine-wide prerequisites",
);
for (const file of [tools.node, tools.git, tools.codex])
  assert.equal(readFileSync(file).toString("ascii", 0, 2), "MZ");
if (process.platform === "win32") {
  const env = {
    SystemRoot: process.env.SystemRoot,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: tools.path.join(";"),
  };
  for (const file of [tools.node, tools.git, tools.codex])
    console.log(
      execFileSync(file, ["--version"], {
        env,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
    );
}
console.log("Verified bundled coding tools independently of system PATH.");
