import { posix } from "node:path";
import { digest, isDocument } from "./brain-index.mjs";
import { resolveDocument } from "./brain-documents.mjs";

export const wikiVersion = 2;
export const wikiHeadings = {
  feature: [
    "What It Does",
    "How It Works",
    "Data And Interfaces",
    "Edge Cases",
    "Validation And Caveats",
  ],
  architecture: [
    "Purpose And Boundaries",
    "Components And Responsibilities",
    "Request And Data Flow",
    "Configuration And Operations",
    "Validation And Caveats",
  ],
  data: [
    "Purpose",
    "Data Sources And Ownership",
    "Relationships And Transformations",
    "Consumers And Interfaces",
    "Validation And Caveats",
  ],
  workflow: [
    "Purpose",
    "Triggers And Inputs",
    "Execution Flow",
    "Failure And Recovery",
    "Validation And Caveats",
  ],
};
export const wikiKind = (path) =>
  /data|schema|migration/i.test(path)
    ? "data"
    : /workflow|pipeline|runbook|operations/i.test(path)
      ? "workflow"
      : /architecture|system map/i.test(path)
        ? "architecture"
        : "feature";
const humanTitle = (path) =>
  posix
    .basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (s) => s.toUpperCase());
const words = (text) =>
  (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(
    (s) =>
      ![
        "the",
        "and",
        "for",
        "api",
        "src",
        "page",
        "route",
        "index",
        "service",
        "feature",
        "backend",
        "frontend",
      ].includes(s),
  );

// Split only real H2 headings. Fenced examples, table bodies and untouched
// sections remain byte-for-byte intact. IDs survive content changes.
export function wikiSections(text) {
  const sections = [];
  let current = { id: "intro", heading: "Introduction", text: "" },
    fence = null;
  const occurrences = new Map();
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
        fence = null;
    }
    const heading = !fence && line.match(/^## ([^\r\n]+)\r?\n?$/);
    if (heading) {
      sections.push(current);
      const name = heading[1].trim(),
        occurrence = occurrences.get(name) || 0;
      occurrences.set(name, occurrence + 1);
      current = {
        id: digest(name + ":" + occurrence).slice(0, 16),
        heading: name,
        text: line,
      };
    } else current.text += line;
  }
  sections.push(current);
  return sections;
}

export function mergeWikiSource(oldSource, maintained, source) {
  if (!oldSource || oldSource === source)
    return oldSource ? maintained : source;
  const old = new Map(wikiSections(oldSource).map((s) => [s.id, s.text]));
  const current = new Map(wikiSections(maintained).map((s) => [s.id, s.text]));
  const incoming = wikiSections(source),
    ids = new Set(incoming.map((s) => s.id));
  // Source-author changes win conflicts. AI-only added sections survive a
  // source edit, but source-deleted sections do not silently reappear.
  return (
    incoming
      .map((s) =>
        old.get(s.id) === s.text ? (current.get(s.id) ?? s.text) : s.text,
      )
      .join("") +
    wikiSections(maintained)
      .filter((s) => !old.has(s.id) && !ids.has(s.id))
      .map((s) => s.text)
      .join("")
  );
}

export function wikiCatalog(index) {
  const pages = Object.entries(index.files)
    .filter(([path]) => isDocument(path))
    .map(([path, file]) => ({
      path,
      source: file.text,
      sourceHash: file.hash,
      kind: wikiKind(path),
      title: file.headings?.[0]?.name || humanTitle(path),
      maintain:
        !path.startsWith(".") &&
        !/(?:^|\/)(?:01 Rules|07 Audits|99 Sources|rules|skills)(?:\/|$)|(?:^|\/)(?:AGENTS|SKILL)\.md$/i.test(
          path,
        ),
    }));
  const code = Object.entries(index.files).filter(([p]) => !isDocument(p));
  const used = new Set(pages.map((p) => p.path));
  const add = (kind, title, evidence) => {
    const folder = {
      feature: "06 Features",
      architecture: "02 Architecture",
      data: "04 Data",
      workflow: "02 Architecture",
    }[kind];
    const path = `wiki/${folder}/${title.replace(/[^a-zA-Z0-9 _-]/g, "-").slice(0, 70)}.md`;
    if (used.has(path) || !evidence.length) return;
    used.add(path);
    const source =
      `# ${title}\n\n` +
      wikiHeadings[kind]
        .map((h) => `## ${h}\n\nNot yet documented.\n\n`)
        .join("");
    pages.push({
      path,
      source,
      sourceHash: digest(source),
      kind,
      title,
      maintain: true,
      created: true,
      evidence,
    });
  };
  if (!pages.some((p) => /system map|architecture/i.test(p.path)))
    add("architecture", "System Map", code.map(([p]) => p).slice(0, 8));
  if (!pages.some((p) => /data.*(?:map|relationship)|schema/i.test(p.path)))
    add(
      "data",
      "Data Relationship Map",
      code
        .filter(([p]) => /schema|models?\/|migration|\.sql$/i.test(p))
        .map(([p]) => p)
        .slice(0, 8),
    );
  if (!pages.some((p) => /workflow|pipeline/i.test(p.path)))
    add(
      "workflow",
      "Development Workflow",
      code
        .filter(([p]) =>
          /\.github\/workflows|package\.json|Makefile|Dockerfile|\.toml$/.test(
            p,
          ),
        )
        .map(([p]) => p)
        .slice(0, 8),
    );
  for (const [path, file] of code) {
    if (pages.filter((p) => p.created).length >= 30) break;
    if (!(
      file.routes?.length ||
      /(?:^|\/)(?:features|pages)\/[^/]+\.[jt]sx?$/.test(path)
    ))
      continue;
    const name = humanTitle(path),
      terms = words(name);
    if (!terms.length) continue;
    // Maps/inventories mentioning every path do not count as feature pages.
    if (
      pages.some(
        (p) =>
          p.maintain &&
          p.kind === "feature" &&
          !/(?:^|\/)00 Maps\/|(?:^|\/)(?:README|Home|index)\.md$/i.test(
            p.path,
          ) &&
          (terms.every((t) => words(p.title).includes(t)) ||
            (/(?:^|\/)06 Features\/|(?:^|\/)features\//i.test(p.path) &&
              p.source.includes(path))),
      )
    )
      continue;
    add("feature", name, [
      path,
      ...code
        .filter(([p]) => p !== path && terms.every((t) => words(p).includes(t)))
        .map(([p]) => p)
        .slice(0, 7),
    ]);
  }
  return pages;
}

export function pageEvidence(page, index, previous, state) {
  const referenced = new Set([
    ...(page.evidence || []),
    ...(state?.sources || []),
  ]);
  const terms = words(page.title);
  const files = Object.entries(index.files).filter(([p]) => !isDocument(p));
  const candidates = files
    .map(([path, file]) => ({
      path,
      file,
      score:
        referenced.has(path) || page.source.includes(path)
          ? 10
          : terms.length && terms.every((t) => words(path).includes(t))
            ? 5
            : posix.basename(path).length >= 8 &&
                page.source.includes(posix.basename(path))
              ? 2
              : 0,
    }))
    .filter((e) => e.score)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const manifest = new Set(index.manifest || Object.keys(index.files));
  const missing = [...referenced].filter(
    (p) => index.manifest && !manifest.has(p),
  );
  const changed = candidates
    .filter((e) => previous && previous.files[e.path]?.hash !== e.file.hash)
    .map((e) => e.path);
  return { candidates, missing, changed };
}

export function wikiPatchSchema(sections, sources) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["edits"],
    properties: {
      edits: {
        type: "array",
        minItems: 0,
        maxItems: sections.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sectionId", "markdown", "sources"],
          properties: {
            sectionId: { type: "string", enum: sections.map((s) => s.id) },
            markdown: { type: "string", minLength: 1, maxLength: 8000 },
            sources: {
              type: "array",
              minItems: 1,
              maxItems: sources.length,
              items: { type: "string", enum: sources },
            },
          },
        },
      },
    },
  };
}

export function validateWikiPatch(text, input) {
  if (typeof text !== "string" || text.length > 24_000)
    throw new Error("Wiki edits exceeded the response limit.");
  const result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (
    !result ||
    !Array.isArray(result.edits) ||
    result.edits.length > input.sections.length
  )
    throw new Error("Invalid wiki section edits.");
  const seen = new Set();
  for (const edit of result.edits) {
    if (!edit || typeof edit !== "object")
      throw new Error("Invalid wiki section edit.");
    const section = input.sections.find((s) => s.id === edit.sectionId);
    if (
      !section ||
      seen.has(edit.sectionId) ||
      typeof edit.markdown !== "string" ||
      !edit.markdown.trim() ||
      edit.markdown.length > 8000 ||
      !Array.isArray(edit.sources) ||
      !edit.sources.length ||
      edit.sources.some((p) => !input.sources.includes(p))
    )
      throw new Error("Invalid wiki section target or citations.");
    seen.add(edit.sectionId);
    let fence = null,
      prose = "";
    for (const line of edit.markdown.split("\n")) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = null;
      } else if (!fence) prose += line + "\n";
    }
    if (
      fence ||
      /^#{1,2}(?:\s|$)|^---$|<\/?[a-z]|!\[|https?:\/\//im.test(prose)
    )
      throw new Error(
        "Wiki edit contains unsupported markup or changes section boundaries.",
      );
    for (const m of prose.matchAll(/\[\[([^\]]+)\]\]/g))
      if (!resolveDocument(input.path, m[1], input.links))
        throw new Error("Wiki edit links to an unknown page.");
  }
  return result;
}

export function applyWikiPatch(content, result, input) {
  const sections = wikiSections(content);
  for (const edit of result.edits) {
    const base = input.sections.find((s) => s.id === edit.sectionId),
      at = sections.findIndex((s) => s.id === edit.sectionId);
    if (at < 0 || digest(sections[at].text) !== base.hash)
      throw new Error(
        "Wiki section changed while writing; preserving newer content.",
      );
    const prefix =
      edit.sectionId === "intro"
        ? (sections[at].text.match(
            /^(?:---\r?\n[\s\S]*?\r?\n---\r?\n\s*)?(?:# [^\n]+(?:\n|$))?/,
          )?.[0] || "") + "\n"
        : `## ${base.heading}\n\n`;
    sections[at].text =
      prefix +
      edit.markdown.trim() +
      "\n\nEvidence: " +
      [...new Set(edit.sources)]
        .map((p) => "`" + p.replace(/`/g, "") + "`")
        .join(", ") +
      "\n\n";
  }
  return sections.map((s) => s.text).join("");
}
