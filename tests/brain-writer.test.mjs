import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.mjs";
import {
  BrainWriter,
  writerDefaults,
  writerArgs,
  validateWriterResult,
  runWriter,
} from "../server/brain-writer.mjs";
import { digest } from "../server/brain-index.mjs";

const index = (
  code = "export function charge() {}",
  doc = "# Payments\nUses src/api.js.",
) => ({
  files: {
    "wiki/Payments.md": { hash: digest(doc), text: doc },
    "src/api.js": { hash: digest(code), text: code },
  },
});
async function fixture(t, run) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-writer-test-"));
  const store = new Store(join(dir, "fleet.sqlite"));
  const project = store.put("project", {
    id: "p",
    brainWriter: { enabled: true, dailyCalls: 1 },
  });
  const writer = new BrainWriter(store, { run });
  t.after(async () => {
    await writer.close();
    store.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const plan = (snapshot, scope = "project") => {
    const result = writer.plan(project, snapshot, undefined, { scope });
    store.put("brain-scope", {
      id: `p:${scope}`,
      projectId: "p",
      scope,
      writerKeys: result.keys,
    });
    writer.reconcile(project);
    return result;
  };
  return { store, project, writer, plan };
}
const output = {
  text: JSON.stringify({
    markdown:
      "The payment entry point is declared in `src/api.js`. Runtime behaviour is not verified.",
    sources: ["src/api.js"],
  }),
  usage: { input_tokens: 20, output_tokens: 15 },
};
const sectionOutput = (options) => ({
  text: JSON.stringify({
    edits: [
      {
        sectionId:
          options.schema.properties.edits.items.properties.sectionId.enum[0],
        markdown:
          "The payment entry point is declared in `src/api.js`. Runtime behaviour is not verified.",
        sources: ["src/api.js"],
      },
    ],
  }),
  usage: output.usage,
});
test("real writer subprocess returns JSON and cancellation terminates its owned process group", async () => {
  const bin = fileURLToPath(
    new URL("./fixtures/brain-writer.mjs", import.meta.url),
  );
  const normal = await runWriter({
    bin,
    model: writerDefaults.model,
    prompt: "normal",
    sources: ["src/api.js"],
    signal: new AbortController().signal,
  });
  assert.ok(validateWriterResult(normal.text, ["src/api.js"]).markdown);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(
      runWriter({
        bin,
        model: writerDefaults.model,
        prompt: "hang",
        signal: controller.signal,
      }),
      /stopped/,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("writer pins its own model, caches identical worktree evidence and enforces durable daily call admission", async (t) => {
  let calls = 0;
  const { writer, store, project, plan } = await fixture(t, async (options) => {
    calls++;
    assert.equal(options.model, writerDefaults.model);
    return sectionOutput(options);
  });
  const first = plan(index());
  plan(index(), "feature");
  assert.equal(
    store.list("brain-write").filter((j) => j.path === "wiki/Payments.md")
      .length,
    1,
  );
  await writer.drain();
  assert.equal(calls, 1);
  assert.match(
    plan(index()).pages["wiki/Payments.md"].content,
    /payment entry point/,
  );
  assert.match(
    plan(index(), "feature").pages["wiki/Payments.md"].content,
    /payment entry point/,
  );
  plan(index("export function changed() {}"), "feature");
  await writer.drain();
  assert.equal(calls, 1);
  assert.equal(writer.status(project).status, "budget-paused");
  assert.equal(writer.status(project).used, 1);
  assert.equal(store.list("brain-write-usage").length, 1);
  assert.ok(first.keys.length);
  assert.equal(
    plan(index("export function changed() {}")).pages["wiki/Payments.md"].stale,
    true,
  );
  assert.equal(
    store
      .list("brain-wiki-revision")
      .filter((r) => r.path === "wiki/Payments.md").length,
    2,
  );
});
test("disabled writing imports freely, errors pause without automatic retries, explicit retry still consumes budget", async (t) => {
  let calls = 0;
  const { writer, store, project, plan } = await fixture(t, async () => {
    calls++;
    throw new Error("Model unavailable");
  });
  plan(index());
  writer.configure(project, { enabled: false });
  await writer.drain();
  assert.equal(calls, 0);
  writer.configure(store.get("project", "p"), { enabled: true, dailyCalls: 5 });
  await writer.drain();
  await writer.drain();
  assert.equal(calls, 1);
  assert.equal(
    writer.status(store.get("project", "p")).status,
    "needs-attention",
  );
  writer.configure(store.get("project", "p"), { retry: true });
  await writer.drain();
  assert.equal(calls, 2);
  assert.equal(writer.status(store.get("project", "p")).used, 2);
});
test("irrelevant code changes reuse analysis; deleted pages retire queued work; no matching evidence makes no call", async (t) => {
  let calls = 0;
  const { writer, project, plan, store } = await fixture(t, async (options) => {
    calls++;
    return sectionOutput(options);
  });
  const original = plan(index());
  const changed = index();
  changed.files["src/unrelated.js"] = { hash: "other", text: "unrelated" };
  assert.equal(plan(changed).keys[0], original.keys[0]);
  plan({ files: {} });
  await writer.drain();
  assert.equal(calls, 0);
  assert.equal(writer.status(project).queued, 0);
  assert.equal(store.list("brain-write")[0].active, false);
  plan(index(undefined, "# Unlinked document"));
  // The architecture page may still need writing; the unlinked imported page does not.
  assert.equal(
    plan(index(undefined, "# Unlinked document")).pages["wiki/Payments.md"]
      .status,
    "limited-evidence",
  );
  writer.configure(project, { enabled: false });
  await writer.drain();
  assert.equal(calls, 0);
});
test("writer output validates sources and markup; configuration cannot inherit an expensive model", () => {
  assert.ok(validateWriterResult(output.text, ["src/api.js"]).markdown);
  assert.throws(() => validateWriterResult(output.text, ["invented.js"]));
  assert.throws(() =>
    validateWriterResult(
      JSON.stringify({
        markdown: "![remote](https://example.com)",
        sources: ["src/api.js"],
      }),
      ["src/api.js"],
    ),
  );
  const args = writerArgs(writerDefaults.model);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("read-only"));
  assert.equal(args[args.indexOf("-m") + 1], writerDefaults.model);
  assert.ok(args.includes("shell_tool"));
  assert.ok(args.includes("hooks"));
});
test("interrupted running calls remain charged and require explicit retry on restart", async (t) => {
  const { writer, store, project, plan } = await fixture(t, async () => output);
  const queued = plan(index());
  store.patch("brain-write", queued.keys[0], { status: "running" });
  store.put("brain-write-usage", {
    id: "reserved",
    projectId: "p",
    day: new Date().toISOString().slice(0, 10),
  });
  const restarted = new BrainWriter(store, {
    run: async () => {
      throw new Error("must not run");
    },
  });
  await restarted.drain();
  assert.equal(store.get("brain-write", queued.keys[0]).status, "failed");
  assert.equal(restarted.status(project).used, 1);
  await restarted.close();
});

test("a budget-paused project is checked once per drain, not once for every queued page", async (t) => {
  const { writer, store, project } = await fixture(t, async () => {
    throw new Error("must not run");
  });
  store.put("brain-write-usage", {
    id: "already-spent",
    projectId: project.id,
    day: new Date().toISOString().slice(0, 10),
  });
  for (let i = 0; i < 500; i++)
    store.put("brain-write", {
      id: `waiting-${i}`,
      projectId: project.id,
      version: 2,
      status: "queued",
      active: true,
      createdAt: "2026-01-01",
    });
  let checks = 0;
  const status = writer.status.bind(writer);
  writer.status = (p) => {
    checks++;
    return status(p);
  };
  await writer.drain();
  assert.equal(checks, 1);
});
