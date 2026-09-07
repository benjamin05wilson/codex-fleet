import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const root = resolve(process.argv[2] || "release/win-unpacked");
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
]) assert(existsSync(join(runtime, file)), `Missing packaged file: ${file}`);
console.log("Verified standalone Windows x64 runtime and native terminal dependencies.");
