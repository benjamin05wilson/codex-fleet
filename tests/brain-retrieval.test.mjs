import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createApp } from "../server/app.mjs";
import { BrainBroker } from "../server/brain-broker.mjs";
import {
  scopedKnowledge,
  rankKnowledge,
  readKnowledge,
} from "../server/brain-retrieval.mjs";
import {
  brainTool,
  brainInstructions,
  brainStartupConfig,
  brainMcpConfig,
  verifyBrainTool,
} from "../shared/brain-tools.mjs";
import { serveBrowserMcp } from "../server/browser-mcp.mjs";
const note = (filename, content, extra = {}) => ({
  filename,
  title: filename.replace(/\.md$/, ""),
  content,
  scope: "project",
  links: [],
  ...extra,
});

test("section ranking finds deep implementation details, tokenizes identifiers, respects pins and never returns unrelated search hits", () => {
  const notes = [
    note(
      "Overview.md",
      "# Overview\n" +
        "Generic architecture information.\n".repeat(300) +
        "\n## Stock checker fallback\n\nstock_checker checks warehouse allocation.\n",
    ),
    note("Other.md", "# Other\nUnrelated typography."),
    note("Decisions.md", "# Decisions\nKeep REST endpoints."),
  ];
  const result = rankKnowledge(notes, "stockChecker warehouse");
  assert.equal(result[0].filename, "Overview.md");
  assert.ok(result[0].passage.startLine > 300);
  assert.match(result[0].passage.text, /warehouse allocation/);
  assert.ok(!result.some((n) => n.filename === "Other.md"));
  assert.equal(
    rankKnowledge(notes, "stockChecker", {
      pinned: ["Decisions.md"],
      fallback: true,
    })[0].filename,
    "Decisions.md",
  );
  assert.equal(rankKnowledge(notes, "nonexistentXYZ").length, 0);
});
test("worktree overlays never fall back to stale project facts; proposals, excluded notes and other branches stay private", () => {
  const notes = [
    note("Main.md", "merged", { topic: "stock" }),
    note("Local.md", "pending", {
      topic: "stock",
      scope: "worktree-a",
      stale: true,
    }),
    note("Foreign.md", "foreign", { scope: "worktree-b" }),
    note("Proposal.md", "unapproved", { proposal: true }),
    note("Private.md", "excluded"),
  ];
  const pool = scopedKnowledge(notes, {
    scope: "worktree-a",
    excluded: ["Private.md"],
  });
  assert.equal(pool.notes.length, 0);
  assert.ok(pool.omitted.some((n) => n.reason === "stale"));
});
test("page reads paginate without truncation ambiguity and expose only eligible related notes", () => {
  const notes = [
    note(
      "Long.md",
      Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`).join("\n"),
      { links: ["Related|alias", "Forbidden"] },
    ),
    note("Related.md", "Related"),
  ];
  const first = readKnowledge(notes, "Long.md");
  assert.equal(first.endLine, 100);
  assert.equal(first.nextStartLine, 101);
  assert.deepEqual(first.related, ["Related.md"]);
  assert.ok(readKnowledge(notes, "Long.md", 101).text.startsWith("Line 101"));
  assert.throws(() => readKnowledge(notes, "../Long.md"), /unavailable/);
  assert.throws(() => readKnowledge(notes, "Long.md", 999));
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-brain-tools-"));
  const app = await createApp({
    dataDir: dir,
    bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
  });
  const project = app.store.put("project", {
    id: "p",
    name: "Project",
    path: dir,
  });
  const run = app.store.put("run", {
    id: "r",
    projectId: "p",
    status: "running",
    attempt: 1,
    brainScope: "worktree-a",
    contextOptions: { excluded: ["Excluded.md"] },
    worker: { identity: "owner", persistent: true },
  });
  app.brain.list = async () => [
    note(
      "Stock.md",
      "# Stock\n\n## Fallback\nStock checks warehouse availability.\n[[Related]]",
      { scope: "worktree-a", links: ["Related"] },
    ),
    note("Related.md", "# Related\nStock schema."),
    note("Foreign.md", "Stock SECRET_FOREIGN", { scope: "worktree-b" }),
    note("Stale.md", "Stock OLD", { stale: true }),
    note("Excluded.md", "Stock PRIVATE"),
  ];
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const connection = app.brainTools.connection(run, "owner");
  t.after(async () => {
    await app.close();
    app.store.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const call = (input, token = connection.token) =>
    fetch(connection.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(input),
    });
  return { app, project, run, connection, call, dir };
}
test("HTTP brain capability is read-only, project-bound, revocable, respects exclusions and records supplied pages", async (t) => {
  const { app, call } = await fixture(t);
  assert.equal(
    (await call({ action: "search", query: "stock" }, "wrong")).status,
    403,
  );
  const result = await (
    await call({ action: "search", query: "stock" })
  ).json();
  assert.equal(result.results.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_FOREIGN|PRIVATE|OLD/);
  const read = await (
    await call({ action: "read", filename: "Stock.md" })
  ).json();
  assert.match(read.text, /warehouse availability/);
  assert.deepEqual(read.related, ["Related.md"]);
  for (const input of [
    { action: "write", filename: "Stock.md" },
    { action: "read", filename: "../fleet.sqlite" },
    { action: "search", query: "stock", projectId: "other" },
  ])
    assert.equal((await call(input)).status, 400);
  for (const filename of ["Foreign.md", "Stale.md", "Excluded.md"])
    assert.equal((await call({ action: "read", filename })).status, 404);
  assert.ok(
    app.store.db
      .prepare("SELECT count(*) AS n FROM events WHERE type='brain.retrieved'")
      .get().n >= 2,
  );
  app.store.patch("run", "r", { worker: { identity: "replacement" } });
  assert.equal((await call({ action: "search", query: "stock" })).status, 403);
});
test("mid-request turn replacement cannot return old-scope data; new exclusions apply immediately", async (t) => {
  const { app, call, project } = await fixture(t);
  const list = app.brain.list;
  app.brain.list = async (...args) => {
    app.store.patch("run", "r", { attempt: 2 });
    return list(...args);
  };
  assert.equal((await call({ action: "search", query: "stock" })).status, 403);
  app.brain.list = list;
  app.store.patch("project", project.id, {
    contextPreferences: { excluded: ["Related.md"] },
  });
  const result = await (
    await call({ action: "search", query: "stock" })
  ).json();
  assert.deepEqual(
    result.results.map((n) => n.filename),
    ["Stock.md"],
  );
});
test("durable capability recovery restores only the currently owned worker", async (t) => {
  const { app, connection, dir, run } = await fixture(t);
  const directory = join(dir, "workers", run.id, "attempt");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ identity: "owner", run, brain: connection }),
  );
  app.store.patch("run", run.id, { worker: { identity: "owner", directory } });
  const restored = new BrainBroker(app.engine);
  assert.equal(restored.check(connection.token).run.id, run.id);
  app.store.patch("run", run.id, { deletedAt: "now" });
  assert.throws(() => restored.check(connection.token), /stopped/);
  restored.close();
});
test("changing context permissions during a lookup discards the old result", async (t) => {
  const { app, call, project } = await fixture(t);
  const list = app.brain.list;
  app.brain.list = async (...args) => {
    app.store.patch("project", project.id, {
      contextPreferences: { excluded: ["Stock.md"] },
    });
    return list(...args);
  };
  assert.equal(
    (await call({ action: "read", filename: "Stock.md" })).status,
    403,
  );
});
test("MCP exposes brain search/read without browser controls and keeps capabilities out of startup argv", async (t) => {
  const { connection } = await fixture(t);
  const input = new PassThrough(),
    output = new PassThrough(),
    replies = new Map();
  const lines = createInterface({ input: output });
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    replies.set(m.id, m.result);
  });
  const close = serveBrowserMcp({
    input,
    output,
    tool: brainTool,
    serverName: "fleet-brain",
    url: connection.url,
    capability: connection.token,
    timeoutMs: 2000,
  });
  t.after(() => {
    close();
    lines.close();
    input.destroy();
    output.destroy();
  });
  const rpc = async (id, method, params = {}) => {
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 200 && !replies.has(id); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(replies.has(id));
    return replies.get(id);
  };
  assert.equal((await rpc(1, "tools/list")).tools[0].name, "fleet_brain");
  const result = await rpc(2, "tools/call", {
    name: "fleet_brain",
    arguments: { action: "search", query: "warehouse" },
  });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Stock.md/);
  const startup = brainStartupConfig(connection);
  assert.ok(!startup.args.join(" ").includes(connection.token));
  assert.equal(startup.env.FLEET_BRAIN_CAPABILITY, connection.token);
  assert.equal(
    brainMcpConfig(connection).config["mcp_servers.fleet_brain"].required,
    true,
  );
  assert.match(brainInstructions(true), /search/);
  assert.match(brainInstructions(false), /no live brain tool/);
  await verifyBrainTool({
    request: async () => ({
      data: [
        {
          name: "fleet_brain",
          tools: { fleet_brain: { name: "fleet_brain" } },
        },
      ],
    }),
  });
  await assert.rejects(
    verifyBrainTool({ request: async () => ({ data: [] }) }),
    /did not connect/,
  );
});
