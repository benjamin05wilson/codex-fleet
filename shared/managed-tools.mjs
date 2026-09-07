import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

export function managedTools(
  resources,
  platform = process.platform,
  arch = process.arch,
) {
  const root = join(resources, "tools");
  const win = platform === "win32";
  const triple = win ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin";
  if (!(win && arch === "x64") && !(platform === "darwin" && arch === "arm64"))
    return null;
  const node = join(
    root,
    "node",
    `node-v24.19.0-${win ? "win-x64" : "darwin-arm64"}`,
    ...(win ? ["node.exe"] : ["bin", "node"]),
  );
  const codexRoot = join(root, "codex", "package", "vendor", triple);
  const codex = join(codexRoot, "bin", win ? "codex.exe" : "codex");
  const git = win ? join(root, "git", "cmd", "git.exe") : null;
  if (![node, codex, ...(git ? [git] : [])].every(existsSync)) return null;
  return {
    node,
    codex,
    git,
    path: [
      dirname(node),
      dirname(codex),
      join(codexRoot, "codex-path"),
      ...(git ? [dirname(git)] : []),
    ],
  };
}
