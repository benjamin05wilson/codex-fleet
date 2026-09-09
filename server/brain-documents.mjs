import { posix } from "node:path";
import { digest, isDocument } from "./brain-index.mjs";

export const documentTopic = (path) =>
  `Document ${posix
    .basename(path)
    .replace(/\.(mdx?)$/i, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "-")
    .slice(0, 60)} ${digest(path).slice(0, 12)}`;
export const documentName = (path, scope = "project") =>
  `Code ${documentTopic(path)}${scope === "project" ? "" : ` ${scope.slice(-8)}`}`;

// Resolve exact/relative paths first. Bare Obsidian names resolve only if unique.
// Never guess between same-named pages from different folders.
export function resolveDocument(from, target, paths) {
  let value;
  try {
    value = decodeURIComponent(target.split("|")[0].split("#")[0].trim());
  } catch {
    return null;
  }
  if (!value) return from;
  if (/^[a-z]+:|^\/\/|\\/i.test(value)) return null;
  const normal = (p) =>
    posix
      .normalize(p)
      .replace(/^\//, "")
      .replace(/\.mdx?$/i, "");
  for (const candidate of [
    normal(posix.join(posix.dirname(from), value)),
    normal(value),
  ]) {
    const match = paths.filter((p) => normal(p) === candidate);
    if (match.length === 1) return match[0];
  }
  const matches = paths.filter(
    (p) => normal(posix.basename(p)) === normal(value),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function documentBody(path, text, paths, scope) {
  const link = (target, label) => {
    const resolved = resolveDocument(path, target, paths);
    if (!resolved) return null;
    const anchor = target.split("|")[0].includes("#")
      ? "#" + target.split("|")[0].split("#").slice(1).join("#")
      : "";
    return `[[${documentName(resolved, scope)}${anchor}|${label}]]`;
  };
  // Keep fenced code literal: a code example is not a graph relationship.
  return text
    .split(/(^```[^\n]*\n[\s\S]*?^```\s*$|^~~~[^\n]*\n[\s\S]*?^~~~\s*$)/gm)
    .map((chunk, i) =>
      i % 2
        ? chunk
        : chunk
            .replace(
              /\[\[([^\]]+)\]\]/g,
              (all, target) =>
                link(target, target.split("|")[1] || target.split("#")[0]) ||
                all,
            )
            .replace(
              /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g,
              (all, label, target) =>
                link(target.replace(/^<|>$/g, ""), label) || all,
            ),
    )
    .join("");
}

export function documentNotes(index, scope, insights = {}) {
  const paths = [
    ...new Set([
      ...Object.keys(index.files).filter(isDocument),
      ...Object.keys(insights),
    ]),
  ];
  return paths.map((path) => {
    const file = index.files[path],
      insight = insights[path];
    const sourceText = (insight?.content ?? file?.text ?? "").replace(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
      (_, metadata) => "```yaml\n" + metadata + "\n```\n",
    );
    const title =
      file?.headings?.[0]?.name || posix.basename(path).replace(/\.mdx?$/i, "");
    return {
      filename: `${documentName(path, scope)}.md`,
      topic: documentTopic(path),
      sourcePath: path,
      maintenance: insight
        ? {
            status: insight.status,
            revisions: insight.revisions || 0,
            created: !!insight.created,
            kind: insight.kind,
            model: insight.model,
          }
        : { status: "imported" },
      wikiStale: !!insight?.stale,
      content: `---\nkind: generated\nscope: ${scope}\nsource_commit: ${index.head}\nsource_snapshot: ${index.snapshot}\nverification: static-analysis\nupdated: ${index.capturedAt}\n---\n\n${sourceText.match(/^# /m) ? "" : "# " + title + "\n\n"}${documentBody(path, sourceText, paths, scope)}\n\n---\n\n${insight?.created ? "Fleet wiki page" : "Source document"}: ${JSON.stringify(path)}${scope !== "project" ? " · working copy, not merged facts" : " · project scope"}. ${insight?.stale ? "Needs review: supporting source evidence changed. " : ""}${insight?.status === "retired" ? "Retired: supporting files no longer exist in this scope. " : ""}${insight?.model ? `Maintained by ${insight.model} · ${insight.revisions || 0} revisions. AI-written sections are not independently verified or human-approved.` : "Source-authored content is not independently verified."}\n\nRelated: [[Code Documentation${scope === "project" ? "" : ` ${scope.slice(-8)}`}]]\n`,
    };
  });
}
