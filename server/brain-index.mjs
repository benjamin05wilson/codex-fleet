import { createHash } from "node:crypto";
import { posix, resolve, relative } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { git, safeRead } from "./git.mjs";
import { searchablePath } from "./search.mjs";
import { redact } from "./sentinel.mjs";
import { documentNotes, documentName } from "./brain-documents.mjs";

export const brainLimits = {
  files: 500,
  bytes: 4_000_000,
  fileBytes: 80_000,
  documents: 1500,
  documentBytes: 32_000_000,
  documentFileBytes: 512_000,
  worktrees: 20,
};
export const isDocument = (path) =>
  /\.(?:md|mdx)$/i.test(path) || /(?:^|\/)README$/i.test(path);
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const knowledgeFingerprint = (content) =>
  digest(
    content.replace(/^---\r?\n[\s\S]*?\r?\n---/, (metadata) =>
      metadata.replace(
        /^(?:source_commit|source_snapshot|updated): .*\r?\n/gm,
        "",
      ),
    ),
  );
export const indexable = (path) =>
  searchablePath(path) &&
  !path
    .split("/")
    .some((p) =>
      /^(?:\.fleet|\.ssh|\.aws|\.openai|dist|build|release|coverage|target|\.next|\.venv|venv|__pycache__|\.idea|\.vscode)$/i.test(
        p,
      ),
    ) &&
  !/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|\.npmrc|\.netrc|\.git-credentials|.*\.min\.[jc]ss?)$/i.test(
    path,
  ) &&
  /(?:\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|rb|php|swift|c|h|cpp|hpp|md|mdx|json|toml|mod|ya?ml|sql|graphql|sh|ps1|html|css)|(?:^|\/)(?:Dockerfile|Makefile|README|AGENTS|requirements\.txt))$/i.test(
    path,
  );
const clean = (s) =>
  redact(String(s))
    .replace(/[\r\n\[\]`|]/g, " ")
    .slice(0, 180);
export const scopeFor = async (root) => {
  let canonical = await realpath(root);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  return `worktree-${digest(canonical).slice(0, 16)}`;
};

export async function projectRevision(project) {
  if (project.brainRef)
    return {
      ref: project.brainRef,
      head: (
        await git(project.path, ["rev-parse", "--verify", project.brainRef])
      ).trim(),
    };
  for (const ref of [
    "refs/heads/main",
    "refs/heads/master",
    ...(project.branch && project.branch !== "detached"
      ? [`refs/heads/${project.branch}`]
      : []),
    "HEAD",
  ]) {
    try {
      const head = (
        await git(project.path, ["rev-parse", "--verify", ref])
      ).trim();
      return { ref: ref === "HEAD" ? head : ref, head };
    } catch {}
  }
  throw new Error("The project has no readable source revision.");
}

function facts(path, text) {
  const lines = text.split("\n"),
    imports = [],
    symbols = [],
    routes = [],
    headings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(
      /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g,
    ))
      imports.push({ name: clean(m[1]), line: i + 1 });
    const python = line.match(/^\s*(?:from|import)\s+([a-zA-Z_][\w.]*)/);
    if (path.endsWith(".py") && python)
      imports.push({ name: python[1], line: i + 1 });
    const symbol = line.match(
      /(?:^|\s)(?:export\s+)?(?:async\s+)?(?:function|class|interface|def|struct|enum|fn|func)\s+([\w]+)/,
    );
    if (symbol && symbols.length < 30)
      symbols.push({ name: clean(symbol[1]), line: i + 1 });
    const route = line.match(
      /(?:\.(get|post|put|patch|delete|route)\s*\(\s*|@(Get|Post|Put|Patch|Delete)\s*\(\s*)["']([^"']+)["']/i,
    );
    if (route && routes.length < 30)
      routes.push({
        name: `${(route[1] || route[2]).toUpperCase()} ${clean(route[3])}`,
        line: i + 1,
      });
    if (/\.mdx?$/i.test(path) && /^#{1,3} /.test(line) && headings.length < 12)
      headings.push({ name: clean(line.replace(/^#+ /, "")), line: i + 1 });
  }
  let packages = [],
    scripts = [],
    description = "";
  if (posix.basename(path) === "package.json") {
    try {
      const p = JSON.parse(text);
      packages = Object.entries({ ...p.dependencies, ...p.devDependencies })
        .slice(0, 80)
        .map(([name, version]) => `${clean(name)} ${clean(version)}`);
      scripts = Object.entries(p.scripts || {})
        .slice(0, 25)
        .map(([name, command]) => `${clean(name)}: ${clean(command)}`);
      description = clean(p.description || "");
    } catch {}
  }
  if (/\.(?:toml|mod)$/i.test(path)) {
    let section = "";
    for (const line of lines) {
      if (/^\[/.test(line)) section = line;
      if (/dependencies|scripts/.test(section) && /^[\w.-]+\s*=/.test(line)) {
        (section.includes("scripts") ? scripts : packages).push(clean(line));
      }
      if (path.endsWith("go.mod") && /^\s*[\w.-]+\.[\w./-]+\s+v\d/.test(line))
        packages.push(clean(line));
    }
    packages = packages.slice(0, 80);
    scripts = scripts.slice(0, 25);
  }
  if (posix.basename(path) === "requirements.txt")
    packages = lines
      .filter((l) => /^[\w.-]+(?:[<>=!~]|$)/.test(l))
      .slice(0, 80)
      .map(clean);
  return {
    imports: imports.slice(0, 60),
    symbols,
    routes,
    headings,
    packages,
    scripts,
    description,
    test: /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:[._-](?:test|spec)\.)/i.test(
      path,
    ),
    config: /(?:\.github\/|Dockerfile|compose|\.toml$|\.ya?ml$)/i.test(path),
  };
}

// No project code, build hooks, external services or Git filters are executed.
// HEAD blobs are pinned before reads; working copies are checked again below.
export async function capture(root, { revision, previous } = {}) {
  const capturedAt = new Date().toISOString();
  const head = revision || (await git(root, ["rev-parse", "HEAD"])).trim();
  const tree = revision
    ? (await git(root, ["ls-tree", "-r", "-l", "-z", head]))
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const tab = row.indexOf("\t"),
            [mode, type, object, size] = row.slice(0, tab).trim().split(/\s+/);
          return {
            path: row.slice(tab + 1),
            mode,
            type,
            object,
            size: Number(size),
          };
        })
        .filter((f) => f.type === "blob" && f.mode !== "120000")
    : [
        ...new Set(
          (
            await git(root, [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "-z",
            ])
          )
            .split("\0")
            .filter(Boolean),
        ),
      ].map((path) => ({ path }));
  const changedPaths = new Set(),
    deletedPaths = new Set();
  if (previous?.head && previous.head !== head) {
    for (const path of (
      await git(root, [
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--name-only",
        "-z",
        previous.head,
        head,
      ])
    )
      .split("\0")
      .filter(Boolean))
      changedPaths.add(path);
  }
  if (!revision) {
    const status = (
      await git(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).split("\0");
    for (let i = 0; i < status.length; i++) {
      if (!status[i]) continue;
      const flags = status[i].slice(0, 2),
        path = status[i].slice(3);
      changedPaths.add(path);
      if (flags.includes("D")) deletedPaths.add(path);
      if (/[RC]/.test(flags)) i++;
    }
  }
  // Keep recently changed evidence in the next stable snapshot too; otherwise
  // a just-committed feature can fall out of the budget on the following poll.
  const priorityPaths = [
    ...new Set([...changedPaths, ...(previous?.priorityPaths || [])]),
  ]
    .filter((path) => indexable(path) && !isDocument(path))
    .slice(0, brainLimits.files);
  const priorities = new Map(priorityPaths.map((path, rank) => [path, rank]));
  const candidates = tree
    .filter((f) => indexable(f.path) && !deletedPaths.has(f.path))
    .sort(
      (a, b) =>
        Number(!/(README|package\.json|AGENTS|\.toml$)/i.test(a.path)) -
          Number(!/(README|package\.json|AGENTS|\.toml$)/i.test(b.path)) ||
        a.path.localeCompare(b.path),
    );
  const documents = candidates
    .filter((f) => isDocument(f.path))
    .sort(
      (a, b) =>
        Number(!/(?:^|\/)wiki\//i.test(a.path)) -
          Number(!/(?:^|\/)wiki\//i.test(b.path)) ||
        a.path.localeCompare(b.path),
    );
  const code = candidates.filter((f) => !isDocument(f.path));
  const coverage = {
    documents: { total: documents.length, indexed: 0, skipped: 0 },
    wiki: {
      total: documents.filter((f) => /(?:^|\/)wiki\//i.test(f.path)).length,
      indexed: 0,
    },
    code: { total: code.length, indexed: 0, skipped: 0 },
    excluded: tree.length - candidates.length,
    omissions: [],
  };
  const files = {};
  const referencedPaths = new Set();
  function* ordered() {
    yield* documents;
    // Once documentation is read, spend the code budget on its cited files first.
    code.sort(
      (a, b) =>
        (priorities.get(a.path) ?? brainLimits.files) -
          (priorities.get(b.path) ?? brainLimits.files) ||
        Number(!referencedPaths.has(a.path)) -
          Number(!referencedPaths.has(b.path)),
    );
    yield* code;
  }
  let bytes = 0,
    documentBytes = 0,
    codeBytes = 0;
  const omit = (file, reason) => {
    coverage[isDocument(file.path) ? "documents" : "code"].skipped++;
    if (coverage.omissions.length < 100)
      coverage.omissions.push({ path: file.path, reason });
  };
  // Documentation has an independent budget. Code can never crowd out a wiki.
  for (const file of ordered()) {
    const document = isDocument(file.path);
    const bucket = document ? coverage.documents : coverage.code;
    const fileLimit = document
      ? brainLimits.documentFileBytes
      : brainLimits.fileBytes;
    const byteLimit = document ? brainLimits.documentBytes : brainLimits.bytes;
    if (
      bucket.indexed >= (document ? brainLimits.documents : brainLimits.files)
    ) {
      omit(file, "file budget");
      continue;
    }
    if (file.size > fileLimit) {
      omit(file, "file too large");
      continue;
    }
    let raw;
    try {
      if (!revision) {
        const canonical = await realpath(resolve(root, file.path));
        const rel = relative(await realpath(root), canonical).replaceAll(
          "\\",
          "/",
        );
        if (!indexable(rel) || rel.startsWith("../")) {
          omit(file, "excluded or outside project");
          continue;
        }
        let cursor = root,
          linked = false;
        for (const part of file.path.split("/")) {
          cursor = resolve(cursor, part);
          if ((await lstat(cursor)).isSymbolicLink()) {
            linked = true;
            break;
          }
        }
        if (linked) {
          omit(file, "symlink");
          continue;
        }
      }
      raw = revision
        ? previous?.files[file.path]?.object === file.object
          ? previous.files[file.path].text
          : await git(root, ["cat-file", "blob", file.object])
        : await safeRead(root, file.path, fileLimit);
    } catch (error) {
      if (error.code === "ENOENT") {
        omit(file, "missing file");
        continue;
      }
      throw error;
    }
    if (
      raw === null ||
      raw.includes("\0") ||
      Buffer.byteLength(raw) + (document ? documentBytes : codeBytes) >
        byteLimit
    ) {
      omit(
        file,
        raw === null
          ? "file too large"
          : raw.includes("\0")
            ? "binary"
            : "byte budget",
      );
      continue;
    }
    bytes += Buffer.byteLength(raw);
    if (document) documentBytes += Buffer.byteLength(raw);
    else codeBytes += Buffer.byteLength(raw);
    bucket.indexed++;
    if (document && /(?:^|\/)wiki\//i.test(file.path)) coverage.wiki.indexed++;
    const text = redact(raw),
      hash = digest(text);
    if (document)
      for (const match of text.matchAll(
        /[a-zA-Z0-9_./@-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|rb|php|swift|sql|ya?ml|json)\b/g,
      ))
        referencedPaths.add(match[0].replace(/^\.\//, ""));
    files[file.path] =
      previous?.files[file.path]?.hash === hash
        ? { ...previous.files[file.path], object: file.object || null }
        : {
            hash,
            object: file.object || null,
            text,
            ...facts(file.path, text),
          };
  }
  const skipped =
    coverage.excluded + coverage.documents.skipped + coverage.code.skipped;
  const snapshot = digest(
    JSON.stringify([
      3,
      head,
      coverage,
      candidates.map((f) => f.path),
      Object.entries(files).map(([p, f]) => [p, f.hash]),
    ]),
  );
  return {
    head,
    priorityPaths,
    manifest: candidates.map((f) => f.path),
    snapshot,
    files,
    skipped,
    bytes,
    coverage,
    truncated: coverage.documents.skipped > 0 || coverage.code.skipped > 0,
    capturedAt,
  };
}

export function compareSnapshots(before, after) {
  if (!before)
    return {
      unknown: true,
      added: [],
      removed: [],
      modified: [],
      renamed: [],
      evidence: [],
    };
  const added = Object.keys(after.files).filter((p) => !before.files[p]);
  const removed = Object.keys(before.files).filter((p) => !after.files[p]);
  const modified = Object.keys(after.files).filter(
    (p) => before.files[p] && before.files[p].hash !== after.files[p].hash,
  );
  const renamed = [];
  for (const from of [...removed]) {
    const to = added.find(
      (p) => after.files[p].hash === before.files[from].hash,
    );
    if (to) {
      renamed.push({ from, to });
      added.splice(added.indexOf(to), 1);
      removed.splice(removed.indexOf(from), 1);
    }
  }
  const evidence = [...added, ...removed, ...modified]
    .slice(0, 30)
    .map((path) => {
      const old = new Set((before.files[path]?.text || "").split("\n")),
        current = new Set((after.files[path]?.text || "").split("\n"));
      return {
        path,
        added: [...current].filter((l) => !old.has(l)).slice(0, 10),
        removed: [...old].filter((l) => !current.has(l)).slice(0, 10),
      };
    });
  return {
    unknown: false,
    partial: !!(before.truncated || after.truncated),
    added,
    removed,
    modified,
    renamed,
    evidence,
  };
}

export async function worktrees(project) {
  const rows = (
    await git(project.path, ["worktree", "list", "--porcelain", "-z"])
  ).split("\0");
  const result = [];
  let current;
  for (const row of rows) {
    if (row.startsWith("worktree ")) {
      current = { path: row.slice(9), branch: "detached" };
      result.push(current);
    } else if (current && row.startsWith("branch "))
      current.branch = row.slice(7).replace(/^refs\/heads\//, "");
    else if (current && row.startsWith("HEAD ")) current.head = row.slice(5);
    else if (current && row.startsWith("prunable")) current.prunable = true;
  }
  return result.filter((w) => !w.prunable).slice(0, brainLimits.worktrees);
}

export function knowledgeNotes(index, scope, label, insights = {}) {
  const suffix = scope === "project" ? "" : ` ${scope.slice(-8)}`;
  const title = (topic) => `Code ${topic}${suffix}`;
  const link = (topic) => `[[${title(topic)}]]`;
  const source = (path, line) => `\`${clean(path)}${line ? `:${line}` : ""}\``;
  const groups = new Map();
  for (const [path, file] of Object.entries(index.files)) {
    if (isDocument(path)) continue;
    const group = path.includes("/") ? path.split("/")[0] : "root";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ path, ...file });
  }
  const topicFor = (group) =>
    `Component ${group.replace(/[^a-zA-Z0-9 _-]/g, "-").slice(0, 45)} ${digest(group).slice(0, 6)}`;
  const features = Object.entries(index.files)
    .flatMap(([path, file]) =>
      file.routes.map((route) => ({
        path,
        route,
        topic: `Feature ${route.name.replace(/[^a-zA-Z0-9 _-]/g, "-").slice(0, 40)} ${digest(path + route.line).slice(0, 6)}`,
      })),
    )
    .slice(0, 24);
  const notes = [];
  const add = (topic, content) =>
    notes.push({
      filename: `${title(topic)}.md`,
      topic,
      content: `---\nkind: generated\nscope: ${scope}\nsource_commit: ${index.head}\nsource_snapshot: ${index.snapshot}\nverification: static-analysis\nupdated: ${index.capturedAt}\n---\n\n# ${topic}\n\nScope: **${clean(label)}**${scope !== "project" ? " · working-copy knowledge, not merged project facts" : " · committed project knowledge"}.\n\n${content.slice(0, 100_000)}${content.length > 100_000 ? "\n\nThis note reached its display budget; inspect the source for remaining declarations." : ""}\n\nRelated: ${topic === "Architecture" ? "[[Home]]" : link("Architecture")}\n`,
    });
  add(
    "Architecture",
    `## Components\n\n${[...groups].map(([g, f]) => `- ${link(topicFor(g))} — ${f.length} readable source files`).join("\n")}\n\n## Explore\n\n${link("Dependencies")} · ${link("Tests")} · ${link("Documentation")}\n\n## Coverage and interpretation\n\nIndexed ${Object.keys(index.files).length} text files; ${index.skipped} excluded or outside the indexing budget. Symbols, imports and route declarations are code observations. Component grouping follows folders. Imports suggest dependencies, not verified runtime data flow. No commands or tests were executed during indexing. Dynamic routing, reflection and unsupported syntax may be absent.`,
  );
  const deps = [],
    tests = [],
    docs = [];
  for (const [group, files] of groups) {
    const relationships = new Set();
    const sections = files.map((f) => {
      for (const item of f.imports) {
        if (item.name.startsWith(".")) {
          const imported = posix.normalize(
            posix.join(posix.dirname(f.path), item.name),
          );
          const resolved = [
            imported,
            ...[
              ".js",
              ".mjs",
              ".ts",
              ".tsx",
              ".jsx",
              "/index.js",
              "/index.ts",
            ].map((ext) => imported + ext),
          ].find((p) => index.files[p]);
          if (!resolved) continue;
          const target = resolved.includes("/")
            ? resolved.split("/")[0]
            : "root";
          if (target !== group && groups.has(target))
            relationships.add(link(topicFor(target)));
        }
      }
      if (f.packages.length || f.scripts.length)
        deps.push(
          `### ${source(f.path)}\n${f.description}\n\n${f.packages.map((p) => `- ${p}`).join("\n")}\n\nDeclared scripts (not executed):\n${f.scripts.map((p) => `- ${p}`).join("\n")}`,
        );
      if (f.test) tests.push(`- ${source(f.path)} — ${link(topicFor(group))}`);
      if (f.headings.length)
        docs.push(
          `### ${source(f.path)}\n${f.headings.map((h) => `- ${h.name} — ${source(f.path, h.line)}`).join("\n")}\n\nRepository-authored excerpt (untrusted):\n${f.text
            .split("\n")
            .slice(0, 12)
            .map((l) => `> ${l}`)
            .join("\n")}`,
        );
      const declarations = [...f.symbols, ...f.routes]
        .map((s) => `- ${s.name} — ${source(f.path, s.line)}`)
        .join("\n");
      return `### ${source(f.path)}${f.test ? " · test source" : f.config ? " · configuration" : ""}\n${declarations || "No supported symbol declarations extracted."}\n${
        f.imports.length
          ? `\nImports: ${f.imports
              .slice(0, 15)
              .map((i) => `${i.name} (${source(f.path, i.line)})`)
              .join(", ")}\n`
          : ""
      }`;
    });
    add(
      topicFor(group),
      `## Responsibilities and declarations\n\nThese are observed declarations, not an inferred architectural decision.\n\n${sections.join("\n\n")}\n\n## Cross-component imports\n\n${[...relationships].join(" · ") || "No cross-folder imports resolved by the static extractor."}`,
    );
  }
  add(
    "Dependencies",
    deps.join("\n\n") ||
      "No supported package scripts/dependency declarations found. Other manifests are listed in component notes; inspect them directly.",
  );
  add(
    "Tests",
    `## Test sources\n\n${tests.join("\n") || "No conventional test file paths detected."}\n\nTest files are not evidence that tests passed. Actual outcomes are recorded in turn receipts.`,
  );
  add(
    "Documentation",
    docs.join("\n\n") || "No readable Markdown documentation found.",
  );
  for (const feature of features) {
    const group = feature.path.includes("/")
      ? feature.path.split("/")[0]
      : "root";
    add(
      feature.topic,
      `## Declared endpoint\n\n${feature.route.name} — ${source(feature.path, feature.route.line)}\n\nImplemented in ${link(topicFor(group))}. This route declaration is evidence of an interface, not proof of runtime reachability, authorization or correctness. Follow the component imports to inspect downstream calls.\n\nChecks: ${link("Tests")}`,
    );
  }
  if (features.length)
    add(
      "Features",
      `## Declared interfaces\n\n${features.map((f) => `- ${link(f.topic)} — ${source(f.path, f.route.line)}`).join("\n")}\n\nAt most 24 detected endpoint declarations are shown. Dynamic routes may not be detected.`,
    );
  // A documentation hub links each full page, rather than dropping everything
  // into a truncated collection of twelve-line excerpts.
  const pages = documentNotes(index, scope, insights);
  const oldDocs = notes.findIndex((n) => n.topic === "Documentation");
  if (oldDocs >= 0) notes.splice(oldDocs, 1);
  add(
    "Documentation",
    `## Imported pages\n\n${pages.map((p) => `- [[${documentName(p.sourcePath, scope)}|${p.sourcePath}]]`).join("\n")}\n\nDocumentation coverage: ${index.coverage?.documents.indexed ?? pages.length}/${index.coverage?.documents.total ?? pages.length}. Wiki coverage: ${index.coverage?.wiki.indexed ?? 0}/${index.coverage?.wiki.total ?? 0}. Original repository files are never overwritten by the brain.`,
  );
  return [...notes, ...pages];
}
