import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  realpath,
  lstat,
  readFile,
  readlink,
  mkdir,
  copyFile,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import pathUtils, { join, resolve, isAbsolute } from "node:path";

const exec = promisify(execFile);
export async function git(cwd, args) {
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      "-C",
      cwd,
      ...args,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
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
  const inherited = await seedWorktree(project.path, path, {
    missingOnly: false,
  });
  return {
    worktree: path,
    branch,
    base: head,
    inheritedSourceFiles: inherited.copied,
  };
}

// New worktrees start with the user's current source, including untracked files.
// Existing worktrees can be repaired in missing-only mode without replacing edits.
export async function seedWorktree(
  sourcePath,
  targetPath,
  { missingOnly = true } = {},
) {
  const sourceRoot = await realpath(sourcePath);
  const targetRoot = await realpath(targetPath);
  if (sourceRoot.toLowerCase() === targetRoot.toLowerCase())
    throw new Error("Source and worktree must be different folders.");
  const sourceGit = (
    await git(sourceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  const targetGit = (
    await git(targetRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
  if ((await realpath(sourceGit)) !== (await realpath(targetGit)))
    throw new Error("The worktree does not belong to this project.");
  const files = [
    ...new Set(
      (
        await git(sourceRoot, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
  if (!missingOnly) {
    const currentFiles = new Set(files);
    const committed = (await git(sourceRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean);
    for (const path of committed) if (!currentFiles.has(path)) files.push(path);
  }
  const copied = [];
  const skipped = [];
  const allowed = (path) =>
    !path
      .split("/")
      .some((part) =>
        /^(?:\.git|\.fleet|\.claude-flow|\.playwright-mcp|\.ssh|\.aws|\.env(?:\..*)?|\.npmrc|\.netrc|node_modules|vendor|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_rsa|id_ed25519)$/i.test(
          part,
        ),
      ) && !/\.(?:pem|key|p12)$/i.test(path);
  const safeParent = async (root, path, create) => {
    let current = root;
    for (const part of path.split("/").slice(0, -1)) {
      current = join(current, part);
      let stat = await lstat(current).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!stat && create) {
        await mkdir(current);
        stat = await lstat(current);
      }
      if (
        !stat?.isDirectory() ||
        stat.isSymbolicLink() ||
        !inside(root, await realpath(current))
      )
        return false;
    }
    return true;
  };
  for (const path of files) {
    const source = resolve(sourceRoot, path);
    const target = resolve(targetRoot, path);
    if (
      !allowed(path) ||
      !inside(sourceRoot, source) ||
      !inside(targetRoot, target) ||
      path.split("/").includes("..")
    ) {
      skipped.push(path);
      continue;
    }
    const stat = await lstat(source).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!stat) {
      // Reflect deletions only in a newly created worktree, never during repair.
      if (!missingOnly && (await safeParent(targetRoot, path, false))) {
        const existing = await lstat(target).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (existing?.isFile() && !existing.isSymbolicLink())
          await unlink(target);
      }
      continue;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !(await safeParent(sourceRoot, path, false)) ||
      !(await safeParent(targetRoot, path, true))
    ) {
      skipped.push(path);
      continue;
    }
    const existing = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (
      existing &&
      (missingOnly || !existing.isFile() || existing.isSymbolicLink())
    )
      continue;
    try {
      await copyFile(source, target, missingOnly ? constants.COPYFILE_EXCL : 0);
      copied.push(path);
    } catch (error) {
      if (!(missingOnly && error.code === "EEXIST")) throw error;
    }
  }
  return { copied, skipped };
}
export function inside(root, path, paths = pathUtils) {
  const rel = paths.relative(paths.resolve(root), paths.resolve(path));
  return (
    rel === "" ||
    (!rel.startsWith(".." + paths.sep) &&
      rel !== ".." &&
      !paths.isAbsolute(rel))
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
