// Opt-in installed Codex discovery check; --model also performs one small live
// read-only model turn against synthetic notes, never the user's project data.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.mjs";
import { CodexClient } from "../server/codex-client.mjs";
import {
  brainMcpConfig,
  brainInstructions,
  verifyBrainTool,
} from "../shared/brain-tools.mjs";
if (!process.argv.includes("--run")) {
  console.log(
    "Use --run for installed Codex discovery; add --model for one live synthetic retrieval turn.",
  );
  process.exit(0);
}
const dir = await mkdtemp(join(tmpdir(), "fleet-live-brain-tools-"));
const app = await createApp({
  dataDir: dir,
  bin: fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)),
});
let client;
try {
  app.store.put("project", {
    id: "p",
    path: dir,
    name: "Synthetic brain test",
    brainWriter: { enabled: false },
  });
  const run = app.store.put("run", {
    id: "r",
    projectId: "p",
    status: "running",
    attempt: 1,
    worker: { identity: "live-test", persistent: true },
  });
  app.brain.list = async () => [
    {
      filename: "Stock.md",
      title: "Stock fallback",
      scope: "project",
      content:
        "# Stock fallback\n\nWhen a warehouse does not exist, the fixture returns the literal code STOCK_FIXTURE_42.\nThis is synthetic test data, not production behaviour.",
      links: [],
    },
  ];
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const connection = app.brainTools.connection(run, "live-test");
  client = new CodexClient(
    process.env.FLEET_CODEX_BIN || "codex",
    dir,
    null,
    connection,
  );
  await client.connect();
  await verifyBrainTool(client);
  const { thread } = await client.request("thread/start", {
    cwd: dir,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    model: "gpt-5.6-luna",
    developerInstructions: brainInstructions(true),
    config: {
      ...brainMcpConfig(connection).config,
      web_search: "disabled",
      model_reasoning_effort: "low",
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.plugins": false,
      "features.apps": false,
      "features.code_mode": false,
    },
  });
  await verifyBrainTool(client, thread.id);
  console.log(
    "PASS: installed Codex discovers fleet_brain at startup and on a new thread.",
  );
  if (process.argv.includes("--model")) {
    let resolveDone,
      rejectDone,
      answer = "";
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const timer = setTimeout(
      () => rejectDone(new Error("Live brain test exceeded 60 seconds")),
      60000,
    );
    client.on("notification", (e) => {
      if (
        e.method === "item/completed" &&
        e.params.item?.type === "agentMessage"
      )
        answer = e.params.item.text || answer;
      if (e.method === "turn/completed")
        e.params.turn.status === "completed"
          ? resolveDone()
          : rejectDone(new Error("Live model turn did not complete."));
    });
    try {
      await client.request("turn/start", {
        threadId: thread.id,
        cwd: dir,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        input: [
          {
            type: "text",
            text: "Find the warehouse fallback code in the Fleet brain. You must search with fleet_brain, then read the returned note before answering. Use only that tool. Answer with the exact code and the note filename.",
          },
        ],
      });
      await done;
      const events = app.store
        .events({ runId: "r" })
        .filter((e) => e.type === "brain.retrieved");
      assert.ok(events.some((e) => e.data.action === "search"));
      assert.ok(events.some((e) => e.data.action === "read"));
      assert.match(answer, /STOCK_FIXTURE_42/);
      console.log(
        "PASS: live Codex searched, read and answered using the synthetic brain; both lookups were recorded.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
} finally {
  client?.close();
  await app.close();
  app.store.close();
  console.log("Isolated test directory: " + dir);
}
