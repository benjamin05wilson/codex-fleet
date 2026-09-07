import test from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { inside } from "../server/git.mjs";
import {
  processEnvironment,
  desktopEnvironment,
  nodeCandidates,
  shellCommand,
  terminalCommand,
  commandInvocation,
} from "../shared/platform.mjs";

test("Windows path containment blocks parent traversal, sibling prefixes and other drives", () => {
  const root = "C:\\Users\\Developer\\Project";
  for (const child of [
    root,
    root + "\\src\\main.js",
    "c:\\Users\\Developer\\Project\\src",
  ])
    assert.ok(inside(root, child, win32));
  for (const child of [
    root + "\\..\\private.txt",
    "C:\\Users\\Developer\\Project-other\\file",
    "D:\\private",
    "\\\\server\\share\\file",
  ])
    assert.equal(inside(root, child, win32), false);
});
test("Windows process environment preserves OS and profile variables without leaking application secrets", () => {
  const result = processEnvironment(
    {
      Path: "C:\\Node",
      PATH: "ignored",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\A",
      APPDATA: "C:\\Users\\A\\AppData\\Roaming",
      TEMP: "C:\\Temp",
      CODEX_HOME: "C:\\Codex",
      PRIVATE_API_KEY: "secret",
    },
    "win32",
  );
  assert.equal(result.PATH, "C:\\Node");
  assert.equal(result.Path, undefined);
  assert.equal(result.SystemRoot, "C:\\Windows");
  assert.equal(result.USERPROFILE, "C:\\Users\\A");
  assert.equal(result.CODEX_HOME, "C:\\Codex");
  assert.equal(result.PRIVATE_API_KEY, undefined);
});
test("Windows desktop discovery uses native paths, PATH delimiters and npm's user install location", () => {
  const env = {
    Path: "C:\\Windows\\System32",
    APPDATA: "C:\\Users\\A\\AppData\\Roaming",
    ProgramFiles: "C:\\Program Files",
  };
  const paths = desktopEnvironment(
    env,
    "C:\\Users\\A",
    "C:\\Program Files\\nodejs\\node.exe",
    "win32",
  );
  assert.ok(paths.PATH.startsWith("C:\\Program Files\\nodejs;"));
  assert.ok(paths.PATH.includes(env.APPDATA + "\\npm;"));
  assert.equal(paths.Path, undefined);
  assert.ok(
    nodeCandidates(env, "C:\\Users\\A", "win32").includes(
      "C:\\Program Files\\nodejs\\node.exe",
    ),
  );
});
test("Codex npm shims are resolved without shell interpretation of arguments", () => {
  const script =
    "C:\\Users\\A B\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const input = ["app-server", "-c", 'value="a & b | c"'];
  const result = commandInvocation("codex", input, {
    platform: "win32",
    env: { Path: "C:\\Users\\A B\\npm" },
    exists: (path) => path === script,
    node: "C:\\Node\\node.exe",
  });
  assert.deepEqual(result, {
    bin: "C:\\Node\\node.exe",
    args: [script, ...input],
  });
  assert.throws(
    () =>
      commandInvocation("unknown.cmd", input, {
        platform: "win32",
        env: {},
        exists: () => false,
      }),
    /Cannot find/,
  );
  assert.deepEqual(
    commandInvocation("C:\\bin\\codex.exe", input, { platform: "win32" }),
    { bin: "C:\\bin\\codex.exe", args: input },
  );
});
test("interactive Windows shells use PowerShell and approved command strings use cmd.exe quoting", () => {
  assert.match(
    terminalCommand("win32", { SystemRoot: "D:\\Windows" }).bin,
    /^D:\\Windows\\.*powershell.exe$/,
  );
  assert.deepEqual(
    shellCommand(
      '"C:\\Program Files\\nodejs\\node.exe" --version',
      "win32",
      {},
    ),
    {
      bin: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\node.exe" --version"',
      ],
      windowsVerbatimArguments: true,
    },
  );
  assert.deepEqual(shellCommand("npm test", "darwin"), {
    bin: "/bin/sh",
    args: ["-c", "npm test"],
  });
});
