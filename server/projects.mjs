import { lstat, realpath, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { git, repository } from "./git.mjs";
import { inspectRepository } from "./discovery.mjs";

async function folder(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("Enter an absolute folder path.");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Choose a real directory, not a file or symbolic link.");
  return realpath(path);
}

// Missing Git metadata is different from unreadable or broken metadata.
async function gitRoot(path) {
  for (let at = path; ; at = dirname(at)) {
    try {
      await lstat(join(at, ".git"));
      return at;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (dirname(at) === at) return null;
  }
}

export async function inspectProject(path) {
  const root = await folder(path);
  const owner = await gitRoot(root);
  if (!owner) {
    // Do not mistake a bare repository for an ordinary folder.
    const bare = await git(root, ["rev-parse", "--is-bare-repository"]).catch(
      () => "",
    );
    if (bare.trim() === "true")
      throw new Error("Bare repositories cannot be used as project folders.");
    return { path: root, name: basename(root), kind: "folder", commands: [] };
  }
  const top = await realpath(
    (await git(root, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const hasHead = await git(top, ["rev-parse", "--verify", "HEAD"]).then(
    () => true,
    () => false,
  );
  if (!hasHead)
    return { path: top, name: basename(top), kind: "unborn", commands: [] };
  return { ...(await inspectRepository(top)), kind: "repository" };
}

export async function prepareProject(input) {
  const mode = input.mode || "open";
  if (!["open", "create", "initialise"].includes(mode))
    throw new Error("Unknown project setup mode.");
  if (mode === "open") return repository(input.path);
  if (input.gitApproved !== true)
    throw new Error(
      "Approve local Git initialisation and the empty starting commit first.",
    );
  let path;
  if (mode === "create") {
    const parent = await folder(input.parentPath);
    const name = input.folderName;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name !== name.trim() ||
      name.length > 120 ||
      /[\\/\x00-\x1f]/.test(name) ||
      name === "." ||
      name === ".." ||
      name === ".git"
    )
      throw new Error(
        "Use a single folder name, without slashes or dot segments.",
      );
    if (await gitRoot(parent))
      throw new Error("Choose a location outside an existing Git repository.");
    path = join(parent, name);
    // Exclusive creation: never adopt or overwrite an existing target.
    await mkdir(path);
  } else {
    path = await folder(input.path);
    if (path === dirname(path) || path === (await realpath(homedir())))
      throw new Error(
        "Choose a project folder, not your home or filesystem root.",
      );
    const inspection = await inspectProject(path);
    if (inspection.kind === "repository")
      throw new Error("This folder already has Git history. Open it normally.");
    if (inspection.path !== path)
      throw new Error("Choose the repository root to initialise its history.");
  }
  try {
    if (!(await gitRoot(path)))
      await git(path, ["init", "--template=", "-b", "main"]);
    // --only with no paths creates an empty commit without including staged
    // files. No git add, templates, hooks, remote, or global config changes.
    await git(path, [
      "-c",
      "user.name=Fleet",
      "-c",
      "user.email=fleet@localhost",
      "commit",
      "--allow-empty",
      "--only",
      "-m",
      "Initial project checkpoint",
    ]);
    return await repository(path);
  } catch (e) {
    throw new Error(
      `Project setup stopped at ${path}. Files were left in place; no cleanup was attempted. ${e.message}`,
    );
  }
}
