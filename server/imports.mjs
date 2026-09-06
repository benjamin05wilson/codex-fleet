import {
  readdir,
  lstat,
  open,
  realpath,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { git, repository, inside } from "./git.mjs";
import { scanText } from "./sentinel.mjs";

const ignored = new Set([
  ".git",
  ".gitattributes",
  ".gitmodules",
  ".fleet",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
]);
const sensitive =
  /(^\.env($|\.)|\.(pem|key|p12|pfx|keystore)$|^(id_rsa|id_ed25519|credentials|secrets?)(\.|$)|^\.(npmrc|pypirc|netrc)$)/i;
const digest = (v) => createHash("sha256").update(v).digest("hex");

// Contents never leave this process during review. Import uses these same
// scanned buffers, not a second copy from mutable source paths.
async function inventory(source) {
  if (typeof source !== "string" || !isAbsolute(source))
    throw new Error("Choose an absolute source folder.");
  const root = await realpath(source);
  if (root === dirname(root) || root === (await realpath(homedir())))
    throw new Error(
      "Choose a project folder, not your home or filesystem root.",
    );
  if (!(await lstat(source)).isDirectory())
    throw new Error("Choose a real folder.");
  const files = [],
    buffers = new Map();
  let bytes = 0,
    visited = 0;
  async function walk(relative = "") {
    for (const entry of (
      await readdir(join(root, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 2000)
        throw new Error(
          "Folder exceeds the 2,000-entry review limit. Choose a smaller source folder.",
        );
      const path = relative ? relative + "/" + entry.name : entry.name;
      const target = join(root, path);
      let reason;
      if (ignored.has(entry.name))
        reason = "Generated, dependency or private directory";
      else if (sensitive.test(entry.name)) reason = "Sensitive filename";
      else if (entry.isSymbolicLink()) reason = "Symbolic link";
      else if (!inside(root, await realpath(target)))
        reason = "Outside source folder";
      else if (entry.isDirectory()) {
        await walk(path);
        continue;
      } else if (!entry.isFile()) reason = "Not a regular file";
      if (reason) {
        files.push({ path, excluded: reason });
        continue;
      }
      const stat = await lstat(target);
      if (stat.size > 1_000_000) {
        files.push({ path, excluded: "Over 1 MB" });
        continue;
      }
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let content;
      try {
        const current = await handle.stat();
        if (
          !current.isFile() ||
          current.size > 1_000_000 ||
          !inside(root, await realpath(target))
        )
          throw new Error("A source file changed during review. Try again.");
        const buffer = Buffer.alloc(1_000_001);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1_000_000)
          throw new Error("A source file grew beyond the review limit.");
        content = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      bytes += content.length;
      if (bytes > 20_000_000)
        throw new Error("Source exceeds the 20 MB review limit.");
      if (
        content.includes(0) ||
        !Buffer.from(content.toString("utf8")).equals(content)
      )
        reason = "Binary file; UTF-8 text imports only";
      else if (
        scanText(path, content.toString("utf8")).some(
          (f) => f.rule === "secret",
        ) ||
        /(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/i.test(
          content.toString("utf8"),
        )
      )
        reason = "Possible embedded credential";
      files.push({
        path,
        size: content.length,
        hash: digest(content),
        ...(reason ? { excluded: reason } : {}),
      });
      if (!reason)
        buffers.set(path, { content, executable: !!(stat.mode & 0o111) });
    }
  }
  await walk();
  return {
    root,
    files,
    buffers,
    digest: digest(JSON.stringify({ root, files })),
  };
}
export async function reviewImport(path) {
  const { root, files, digest } = await inventory(path);
  return { path: root, files, digest };
}
export async function importProject(input, dataDir) {
  if (input.snapshotApproved !== true)
    throw new Error("Approve the selected starting snapshot first.");
  const current = await inventory(input.path);
  if (input.snapshotDigest !== current.digest)
    throw new Error(
      "Source files changed since review. Review the snapshot again.",
    );
  const selected = input.selectedFiles;
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 2000 ||
    new Set(selected).size !== selected.length ||
    selected.some((p) => !current.buffers.has(p))
  )
    throw new Error(
      "Select at least one eligible file; excluded files cannot be imported.",
    );
  const destination = join(dataDir, "imports", randomUUID());
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    for (const path of selected) {
      const { content, executable } = current.buffers.get(path);
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await writeFile(join(destination, path), content, {
        flag: "wx",
        mode: executable ? 0o700 : 0o600,
      });
    }
    await git(destination, ["init", "--template=", "-b", "main"]);
    // Explicit paths, never add-all. Imported .gitignore rules do not silently
    // discard files the user selected; no inherited clean filters are invoked.
    for (const path of selected) {
      const oid = (
        await git(destination, [
          "hash-object",
          "-w",
          "--no-filters",
          "--",
          path,
        ])
      ).trim();
      await git(destination, [
        "update-index",
        "--add",
        "--cacheinfo",
        current.buffers.get(path).executable ? "100755" : "100644",
        oid,
        path,
      ]);
    }
    await git(destination, [
      "-c",
      "user.name=Fleet",
      "-c",
      "user.email=fleet@localhost",
      "commit",
      "-m",
      "Reviewed starting snapshot",
    ]);
    return {
      ...(await repository(destination)),
      sourcePath: current.root,
      importedSnapshot: current.digest,
    };
  } catch (e) {
    throw new Error(
      `Snapshot import stopped. Working copy retained at ${destination}. ${e.message}`,
    );
  }
}
