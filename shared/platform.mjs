import { existsSync } from "node:fs";
import { join, win32, posix } from "node:path";
import { spawn } from "node:child_process";

const value = (env, name) =>
  Object.entries(env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
export function processEnvironment(
  env = process.env,
  platform = process.platform,
) {
  const allowed = new Set([
    "path",
    "home",
    "user",
    "tmpdir",
    "lang",
    "codex_home",
    ...(platform === "win32"
      ? [
          "systemroot",
          "windir",
          "comspec",
          "pathext",
          "userprofile",
          "appdata",
          "localappdata",
          "temp",
          "tmp",
          "username",
          "homedrive",
          "homepath",
          "programfiles",
          "programfiles(x86)",
          "programdata",
        ]
      : []),
  ]);
  const result = {};
  for (const [key, item] of Object.entries(env)) {
    if (!allowed.has(key.toLowerCase()) || !item) continue;
    // Windows treats environment names case-insensitively; avoid duplicate PATH keys.
    const canonical = key.toLowerCase() === "path" ? "PATH" : key;
    if (
      !Object.keys(result).some(
        (k) => k.toLowerCase() === canonical.toLowerCase(),
      )
    )
      result[canonical] = item;
  }
  return result;
}
export function desktopEnvironment(
  env = process.env,
  home,
  node,
  platform = process.platform,
) {
  const result = { ...env };
  const previous = value(env, "PATH") || "";
  for (const key of Object.keys(result))
    if (key.toLowerCase() === "path") delete result[key];
  const path = platform === "win32" ? win32 : posix;
  const extras =
    platform === "win32"
      ? [
          value(env, "APPDATA") && path.join(value(env, "APPDATA"), "npm"),
          value(env, "LOCALAPPDATA") &&
            path.join(
              value(env, "LOCALAPPDATA"),
              "Microsoft",
              "WinGet",
              "Links",
            ),
          home && path.join(home, ".local", "bin"),
        ]
      : [
          home && path.join(home, ".local/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ];
  result.PATH = [
    node && path.isAbsolute(node) && path.dirname(node),
    ...extras,
    previous,
  ]
    .filter(Boolean)
    .join(platform === "win32" ? ";" : ":");
  return result;
}
export function nodeCandidates(env, home, platform = process.platform) {
  if (platform === "win32")
    return [
      env.FLEET_NODE_BIN,
      value(env, "ProgramFiles") &&
        win32.join(value(env, "ProgramFiles"), "nodejs", "node.exe"),
      value(env, "LOCALAPPDATA") &&
        win32.join(
          value(env, "LOCALAPPDATA"),
          "Programs",
          "nodejs",
          "node.exe",
        ),
      "node.exe",
    ].filter(Boolean);
  return [
    env.FLEET_NODE_BIN,
    join(home, ".local/node/bin/node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "node",
  ].filter(Boolean);
}
export function shellCommand(
  command,
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32")
    return {
      bin: value(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  return { bin: "/bin/sh", args: ["-c", command] };
}
export function terminalCommand(
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32")
    return {
      bin: win32.join(
        value(env, "SystemRoot") || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: ["-NoLogo", "-NoProfile"],
    };
  return {
    bin: platform === "darwin" ? "/bin/zsh" : "/bin/bash",
    args: platform === "darwin" ? ["-f"] : ["--noprofile", "--norc"],
  };
}
// Never run an npm .cmd shim through a shell with model-supplied arguments.
// Resolve its known Node entry point instead; direct executable installs also work.
export function commandInvocation(
  bin,
  args = [],
  {
    platform = process.platform,
    env = process.env,
    exists = existsSync,
    node = process.execPath,
  } = {},
) {
  if (/\.[cm]?js$/i.test(bin)) return { bin: node, args: [bin, ...args] };
  if (platform !== "win32") return { bin, args };
  if (/\.exe$/i.test(bin)) return { bin, args };
  const path = win32;
  const explicit = /[\\/]/.test(bin);
  const dirs = explicit
    ? [path.dirname(bin)]
    : (value(env, "PATH") || "")
        .split(";")
        .map((s) => s.replace(/^"|"$/g, ""))
        .filter(Boolean);
  const name = path.basename(bin).replace(/\.cmd$/i, "");
  for (const dir of dirs) {
    const exe = path.join(dir, name + ".exe");
    if (exists(exe)) return { bin: exe, args };
    if (name.toLowerCase() === "codex") {
      const script = path.join(
        dir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (exists(script)) return { bin: node, args: [script, ...args] };
    }
  }
  if (/\.cmd$/i.test(bin) || name.toLowerCase() === "codex")
    throw new Error(
      "Cannot find the native Codex CLI. Install @openai/codex in Windows, or set FLEET_CODEX_BIN to codex.exe or its bin/codex.js entry point.",
    );
  return { bin, args };
}
export function stopProcessTree(child, signal = "SIGTERM") {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    // Only terminate descendants of this owned PID, never by executable name.
    const killer = spawn(
      win32.join(
        value(process.env, "SystemRoot") || "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {}
}
