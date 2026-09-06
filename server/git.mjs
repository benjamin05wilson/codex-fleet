import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat, readFile, readlink, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, relative, isAbsolute } from "node:path";

const exec = promisify(execFile);
export async function git(cwd, args) {
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  return stdout;
}
export async function repository(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("Enter an absolute local repository path.");
  const root = await realpath(
    (await git(path, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const branch =
    (await git(root, ["branch", "--show-current"])).trim() || "detached";
  const dirty = Boolean((await git(root, ["status", "--porcelain"])).trim());
  return { path: root, head, branch, dirty };
}
export async function createWorktree(project, run, dataDir) {
  const path = join(dataDir, "worktrees", run.id);
  await mkdir(join(dataDir, "worktrees"), { recursive: true });
  const branch = `fleet/${run.id.slice(0, 8)}`;
  const head = (await git(project.path, ["rev-parse", "HEAD"])).trim();
  await git(project.path, ["worktree", "add", "-b", branch, path, head]);
  return { worktree: path, branch, base: head };
}
export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === "" ||
    (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel))
  );
}
export async function safeRead(root, path, limit = 160_000) {
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error("Path is outside the workspace.");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return null;
  const canonical = await realpath(target);
  if (!inside(await realpath(root), canonical)) return null;
  const content = await readFile(canonical, "utf8");
  return content.includes("\0") ? null : content;
}
export async function changes(run) {
  if (!run.worktree) return { files: [], diff: "" };
  const names = (
    await git(run.worktree, ["diff", "--name-only", "-z", run.base])
  )
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await git(run.worktree, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean);
  const files = [...new Set([...names, ...untracked])].filter(
    (f) => !f.startsWith(".fleet/"),
  );
  let diff = await git(run.worktree, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    run.base,
  ]);
  for (const f of untracked.slice(0, 50)) {
    const content = await safeRead(run.worktree, f).catch(() => null);
    if (content !== null)
      diff +=
        `\n--- /dev/null\n+++ b/${f}\n` +
        content
          .split("\n")
          .map((l) => "+" + l)
          .join("\n") +
        "\n";
  }
  return {
    files,
    diff: diff.slice(0, 250_000),
    truncated: diff.length > 250_000,
  };
}

// Independent of the capped/redacted display diff; includes binary and every untracked file.
export async function snapshot(run) {
  const hash = createHash("sha256").update(run.base);
  hash.update(
    await git(run.worktree, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      run.base,
    ]),
  );
  const files = (
    await git(run.worktree, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const file of files) {
    const path = resolve(run.worktree, file);
    if (!inside(run.worktree, path)) throw new Error("Invalid snapshot path.");
    const stat = await lstat(path);
    hash.update(JSON.stringify([file, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else {
      if (
        !stat.isFile() ||
        stat.size > 25_000_000 ||
        !inside(await realpath(run.worktree), await realpath(path))
      )
        throw new Error("Cannot safely verify this file: " + file);
      hash.update(await readFile(path));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
