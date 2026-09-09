// Local, section-level lexical retrieval. No embedding service or model calls.
const stop = new Set(
  "the and for this that with from have does what how can could should please about into project use using".split(
    " ",
  ),
);
export const termsFor = (text) =>
  [
    ...new Set(
      String(text)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z0-9]+/g) || [],
    ),
  ]
    .filter((t) => t.length > 1 && !stop.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));

export function scopedKnowledge(
  notes,
  { scope = "project", excluded = [] } = {},
) {
  const overlay = new Set(
    notes
      .filter((n) => n.scope === scope && scope !== "project")
      .map((n) => n.topic)
      .filter(Boolean),
  );
  const reason = (n) =>
    ![scope, "project"].includes(n.scope || "project") ||
    (scope !== "project" &&
      n.scope === "project" &&
      (overlay.has(n.topic) ||
        (overlay.size &&
          ["Repository map.md", "Development.md"].includes(n.filename))))
      ? "different worktree or superseded by current worktree"
      : n.stale
        ? "stale"
        : n.proposal
          ? "unapproved proposal"
          : excluded.includes(n.filename)
            ? "excluded"
            : null;
  return {
    notes: notes.filter((n) => !reason(n)),
    omitted: notes
      .filter((n) => reason(n))
      .map((n) => ({ filename: n.filename, reason: reason(n) })),
  };
}

export function passages(note) {
  const lines = note.content.split("\n"),
    chunks = [];
  let start = 0,
    size = 0,
    heading = note.title;
  const flush = (end) => {
    if (end > start)
      chunks.push({
        filename: note.filename,
        heading,
        startLine: start + 1,
        endLine: end,
        text: lines.slice(start, end).join("\n").slice(0, 4000),
      });
    start = end;
    size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i])) {
      flush(i);
      heading = lines[i].replace(/^#+ /, "");
    }
    if (size + lines[i].length > 3000) flush(i);
    size += lines[i].length + 1;
  }
  flush(lines.length);
  return chunks;
}

export function rankKnowledge(
  notes,
  query,
  { pinned = [], fallback = false } = {},
) {
  const terms = termsFor(query),
    phrase = terms.join(" ");
  const documents = notes.map((note) => ({
    note,
    chunks: passages(note),
    contentTerms: new Set(termsFor(note.content)),
    titleTerms: termsFor(`${note.title} ${note.sourcePath || ""}`),
  }));
  const frequency = new Map(
    terms.map((t) => [
      t,
      documents.filter((d) => d.titleTerms.includes(t) || d.contentTerms.has(t))
        .length,
    ]),
  );
  const score = (text, titleTerms) => {
    const words = termsFor(text),
      matches = terms.filter(
        (t) => words.includes(t) || titleTerms.includes(t),
      );
    return (
      matches.reduce(
        (n, t) =>
          n +
          Math.log(1 + (documents.length + 1) / (1 + frequency.get(t))) *
            (words.includes(t) ? 1 : 0) +
          (titleTerms.includes(t) ? 5 : 0),
        0,
      ) +
      (terms.length ? (8 * matches.length) / terms.length : 0) +
      (phrase && words.join(" ").includes(phrase) ? 4 : 0)
    );
  };
  const ranked = documents.map((d) => {
    const best = d.chunks
      .map((c) => ({
        ...c,
        score: score(c.text, [...d.titleTerms, ...termsFor(c.heading)]),
      }))
      .sort((a, b) => b.score - a.score || a.startLine - b.startLine)[0];
    const isPinned = pinned.includes(d.note.filename);
    return {
      ...d.note,
      passage: best,
      score:
        (best?.score || 0) +
        (isPinned ? 1000 : 0) +
        (fallback && (d.note.filename === "Decisions.md" || d.note.approved)
          ? 3
          : 0),
      pinned: isPinned,
    };
  });
  // A small one-hop boost breaks ties; links cannot outrank actual query matches.
  const leaders = ranked
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const linked = new Set(
    leaders.flatMap((n) =>
      (n.links || []).map(
        (l) => l.split(/[|#]/)[0].replace(/\.md$/, "") + ".md",
      ),
    ),
  );
  for (const n of ranked)
    if (n.score > 0 && linked.has(n.filename)) n.score += 0.5;
  return ranked
    .filter((n) => fallback || n.score > 0)
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
}

export function readKnowledge(notes, filename, startLine = 1) {
  const note = notes.find((n) => n.filename === filename);
  if (!note)
    throw Object.assign(
      new Error(
        "Note is unavailable in this chat: it may be stale, excluded, or in another worktree. Inspect current source instead.",
      ),
      { status: 404 },
    );
  const lines = note.content.split("\n");
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length)
    throw new Error("Choose a valid startLine from this note.");
  const output = [];
  let size = 0,
    i = startLine - 1;
  for (; i < lines.length && output.length < 100; i++) {
    if (lines[i].length > 8000)
      throw new Error(
        "This line exceeds the read budget. Inspect its source file instead.",
      );
    if (size + lines[i].length + 1 > 8000) break;
    output.push(lines[i]);
    size += lines[i].length + 1;
  }
  return {
    filename,
    title: note.title,
    scope: note.scope,
    sourcePath: note.sourcePath,
    sourceCommit: note.source,
    verification: note.approved
      ? "human-approved"
      : "unverified project context",
    startLine,
    endLine: i,
    nextStartLine: i < lines.length ? i + 1 : null,
    totalLines: lines.length,
    text: output.join("\n"),
    related: [
      ...new Set(
        (note.links || []).map(
          (l) => l.split(/[|#]/)[0].replace(/\.md$/, "") + ".md",
        ),
      ),
    ]
      .filter((f) => notes.some((n) => n.filename === f))
      .slice(0, 20),
  };
}
