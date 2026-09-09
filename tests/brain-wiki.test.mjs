import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../server/brain-index.mjs";
import {
  wikiSections,
  mergeWikiSource,
  wikiCatalog,
  pageEvidence,
  wikiPatchSchema,
  validateWikiPatch,
  applyWikiPatch,
} from "../server/brain-wiki.mjs";
import { documentNotes, documentName } from "../server/brain-documents.mjs";
import {
  BrainWriter,
  runWriter,
  writerDefaults,
} from "../server/brain-writer.mjs";
import { Store } from "../server/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const file = (text, extra = {}) => ({ text, hash: digest(text), ...extra });
const source =
  "# Stock Checker\n\nPurpose.\n\n## Data Sources\n\n| Table | Purpose |\n|---|---|\n| stock | Availability |\n\n## Behaviour\n\nUses `src/stock.js`.\n\n```md\n## Not a section\n```\n\n## Caveats\n\nHistorical observation, not live validation.\n";
const inputFor = (text) => ({
  path: "wiki/Stock.md",
  sections: wikiSections(text).map((s) => ({ ...s, hash: digest(s.text) })),
  sources: ["src/stock.js"],
  links: ["wiki/Stock.md", "wiki/Data.md"],
});
const editFor = (
  input,
  heading = "Behaviour",
  markdown = "Loads stock from `src/stock.js`. See [[wiki/Data.md|Data]].",
) => ({
  edits: [
    {
      sectionId: input.sections.find((s) => s.heading === heading).id,
      markdown,
      sources: ["src/stock.js"],
    },
  ],
});

test("wiki edits replace one actual section, preserving tables, caveats and fenced headings", () => {
  const input = inputFor(source),
    edit = validateWikiPatch(JSON.stringify(editFor(input)), input);
  assert.equal(input.sections.length, 4);
  const updated = applyWikiPatch(source, edit, input);
  const before = wikiSections(source),
    after = wikiSections(updated);
  assert.equal(after[1].text, before[1].text);
  assert.equal(after[3].text, before[3].text);
  assert.match(after[2].text, /Loads stock/);
  assert.doesNotMatch(updated, /auto-written analysis/);
  assert.throws(
    () =>
      applyWikiPatch(
        source.replace("Uses `src/stock.js`", "Human edit"),
        edit,
        input,
      ),
    /changed while writing/,
  );
});

test("source-author changes win conflicts; unrelated maintained sections survive a reimport", () => {
  const input = inputFor(source),
    maintained = applyWikiPatch(source, editFor(input), input);
  const reimported = mergeWikiSource(
    source,
    maintained,
    source.replace("Availability", "Current inventory"),
  );
  assert.match(reimported, /Current inventory/);
  assert.match(reimported, /Loads stock/);
  const conflict = mergeWikiSource(
    source,
    maintained,
    source.replace("Uses `src/stock.js`", "Human corrected flow"),
  );
  assert.match(conflict, /Human corrected flow/);
  assert.doesNotMatch(conflict, /Loads stock/);
  const removed = mergeWikiSource(
    source,
    maintained,
    wikiSections(source)
      .filter((s) => s.heading !== "Behaviour")
      .map((s) => s.text)
      .join(""),
  );
  assert.doesNotMatch(removed, /## Behaviour/);
});

test("intro updates preserve source frontmatter and title", () => {
  const text =
    "---\nowner: team\n---\n# Stock\n\nOld purpose.\n\n## Data\n\nUntouched.\n";
  const input = inputFor(text);
  const updated = applyWikiPatch(
    text,
    editFor(input, "Introduction", "New purpose."),
    input,
  );
  assert.ok(updated.startsWith("---\nowner: team\n---\n# Stock\n"));
  assert.match(updated, /## Data\n\nUntouched/);
});

test("section output rejects invented citations, targets, links and unbalanced fences; allows literal code", () => {
  const input = inputFor(source);
  for (const markdown of [
    "## Changed boundary",
    "<script>alert(1)</script>",
    "![x](https://example.com)",
    "[[Missing]]",
    "```js\nunclosed",
  ])
    assert.throws(() =>
      validateWikiPatch(
        JSON.stringify(editFor(input, "Behaviour", markdown)),
        input,
      ),
    );
  const bad = editFor(input);
  bad.edits[0].sources = ["secret.js"];
  assert.throws(() => validateWikiPatch(JSON.stringify(bad), input));
  bad.edits[0].sectionId = "invented";
  assert.throws(() => validateWikiPatch(JSON.stringify(bad), input));
  assert.doesNotThrow(() =>
    validateWikiPatch(
      JSON.stringify(
        editFor(
          input,
          "Behaviour",
          "Example:\n\n```md\n## literal\nhttps://example.com\n```",
        ),
      ),
      input,
    ),
  );
});

test("catalog creates structured missing topics without duplicating an existing feature or maintaining policy/audits", () => {
  const index = {
    files: {
      "wiki/06 Features/Stock Checker.md": file(source),
      "wiki/01 Rules/Policy.md": file("# Policy"),
      "wiki/07 Audits/Old findings.md": file("# Audit"),
      "src/stock.js": file("route", { routes: [{ name: "/stock" }] }),
      "src/features/checkout.jsx": file("checkout"),
      "src/models/order.js": file("order model"),
      "package.json": file('{"scripts":{"test":"node --test"}}'),
    },
  };
  const catalog = wikiCatalog(index);
  assert.equal(
    catalog.filter((p) => p.created && p.kind === "feature").length,
    1,
  );
  for (const kind of ["architecture", "data", "workflow"])
    assert.ok(catalog.some((p) => p.created && p.kind === kind));
  assert.equal(catalog.find((p) => p.path.includes("Policy")).maintain, false);
  assert.equal(
    catalog.find((p) => p.path.includes("Old findings")).maintain,
    false,
  );
  const virtual = catalog.find((p) => p.created && p.kind === "feature");
  assert.match(virtual.source, /## Data And Interfaces/);
  const notes = documentNotes(index, "worktree-12345678", {
    [virtual.path]: {
      content: virtual.source,
      created: true,
      kind: "feature",
      status: "queued",
    },
  });
  assert.ok(
    notes.some(
      (n) =>
        n.filename === documentName(virtual.path, "worktree-12345678") + ".md",
    ),
  );
});

test("manifest distinguishes a deleted source from one omitted by the reading budget", () => {
  const page = { title: "Stock", source, evidence: ["src/stock.js"] };
  const omitted = { files: {}, manifest: ["src/stock.js"] };
  assert.deepEqual(pageEvidence(page, omitted).missing, []);
  assert.deepEqual(pageEvidence(page, { files: {}, manifest: [] }).missing, [
    "src/stock.js",
  ]);
});

test("durable maintainer progresses through bounded batches, reuses unchanged work, and protects manual copies", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-wiki-test-"));
  const store = new Store(join(dir, "state.sqlite"));
  let calls = 0;
  const project = store.put("project", {
    id: "wiki-test",
    brainWriter: { dailyCalls: 20 },
  });
  const writer = new BrainWriter(store, {
    run: async ({ schema }) => {
      calls++;
      const ids = schema.properties.edits.items.properties.sectionId.enum;
      return {
        text: JSON.stringify({
          edits: ids.map((sectionId) => ({
            sectionId,
            markdown:
              "Stock records are loaded by `src/stock.js`. Runtime checks remain unverified.",
            sources: ["src/stock.js"],
          })),
        }),
        usage: {},
      };
    },
  });
  t.after(async () => {
    await writer.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const doc =
    source +
    "\n## Operations\n\nStock operations.\n\n## Tests\n\nTesting notes.\n";
  const index = {
    files: {
      "wiki/Stock.md": file(doc),
      "src/stock.js": file("export const stock = [];"),
    },
    manifest: ["wiki/Stock.md", "src/stock.js"],
  };
  const plan = (snapshot = index, options = {}) => {
    const result = writer.plan(project, snapshot, index, options);
    store.put("brain-scope", {
      id: project.id + ":project",
      projectId: project.id,
      scope: "project",
      writerKeys: result.keys,
    });
    writer.reconcile(project);
    return result;
  };
  plan();
  await writer.drain();
  assert.equal(plan().pages["wiki/Stock.md"].status, "pending-sections");
  plan();
  await writer.drain();
  assert.equal(plan().pages["wiki/Stock.md"].status, "current");
  assert.equal(calls, 2);
  assert.equal(store.list("brain-wiki-revision").length, 2);
  assert.equal(plan().pages["wiki/Stock.md"].status, "current");
  const changed = {
    ...index,
    files: {
      ...index.files,
      "src/stock.js": file("export const stock = [1];"),
    },
  };
  const protectedPlan = plan(changed, { protectedPaths: ["wiki/Stock.md"] });
  assert.equal(protectedPlan.pages["wiki/Stock.md"].status, "manual-edits");
  assert.ok(
    !protectedPlan.keys.some(
      (k) => store.get("brain-write", k).path === "wiki/Stock.md",
    ),
  );
  const future = plan(changed);
  assert.equal(future.pages["wiki/Stock.md"].stale, true);
  assert.ok(
    future.keys.some(
      (k) => store.get("brain-write", k).path === "wiki/Stock.md",
    ),
  );
});

test("real subprocess accepts the bounded section-edit schema", async () => {
  const input = inputFor(source);
  const output = await runWriter({
    bin: fileURLToPath(new URL("./fixtures/brain-writer.mjs", import.meta.url)),
    model: writerDefaults.model,
    prompt: "sections",
    sources: input.sources,
    schema: wikiPatchSchema(input.sections, input.sources),
    signal: new AbortController().signal,
  });
  assert.equal(validateWikiPatch(output.text, input).edits.length, 1);
});
