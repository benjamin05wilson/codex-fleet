import { git } from "./git.mjs";
import { redact } from "./sentinel.mjs";
export const searchablePath = (path) =>
  !path
    .split("/")
    .some((part) =>
      /^(?:\.env(?:\.|$)|\.git$|node_modules$|vendor$|credentials?(?:[._-]|$)|secrets?(?:[._-]|$))/i.test(
        part,
      ),
    ) && !/\.(?:pem|key|p12)$/i.test(path);
export async function searchWorkspace(
  store,
  brain,
  query,
  projectId,
  includeExamples = false,
) {
  const q = query.trim().toLowerCase().slice(0, 200);
  if (q.length < 2) return [];
  const projects = store
      .list("project")
      .filter(
        (p) =>
          !p.removedAt &&
          (!p.example || includeExamples || p.id === projectId) &&
          (!projectId || p.id === projectId),
      ),
    allowed = new Set(projects.map((p) => p.id)),
    results = [];
  for (const r of store
    .list("run")
    .filter(
      (r) =>
        allowed.has(r.projectId) &&
        !r.deletedAt &&
        (r.title + " " + r.prompt).toLowerCase().includes(q),
    )
    .slice(0, 12))
    results.push({
      kind: "session",
      id: r.id,
      title: r.title,
      projectId: r.projectId,
    });
  for (const w of store
    .list("workflow")
    .filter(
      (w) =>
        allowed.has(w.projectId) &&
        (w.title + " " + w.objective).toLowerCase().includes(q),
    )
    .slice(0, 6))
    results.push({
      kind: "workflow",
      id: w.id,
      title: w.title,
      projectId: w.projectId,
    });
  for (const p of projects) {
    for (const n of (await brain.list(p))
      .filter((n) => (n.title + " " + n.content).toLowerCase().includes(q))
      .slice(0, 8))
      results.push({
        kind: "note",
        filename: n.filename,
        title: n.title,
        projectId: p.id,
        stale: n.stale,
      });
    const files = (
      await git(p.path, ["ls-tree", "-r", "--name-only", "HEAD"]).catch(
        () => "",
      )
    ).split("\n");
    for (const file of files
      .filter((f) => f.toLowerCase().includes(q) && searchablePath(f))
      .slice(0, 8))
      results.push({ kind: "file", path: file, title: file, projectId: p.id });
  }
  return results.slice(0, 40);
}
export async function previewFile(project, path) {
  if (
    typeof path !== "string" ||
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    !searchablePath(path)
  )
    throw new Error("This file is excluded from previews.");
  const text = await git(project.path, ["show", `HEAD:${path}`]);
  return {
    path,
    revision: (await git(project.path, ["rev-parse", "HEAD"])).trim(),
    content: text.includes("\0")
      ? "Binary file — preview unavailable."
      : redact(text).slice(0, 160000),
    truncated: text.length > 160000,
  };
}
