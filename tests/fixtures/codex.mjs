#!/usr/bin/env node
// Deterministic protocol fixture for tests only. Never used by the application/demo.
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
if (process.argv.includes("--version")) {
  console.log("codex-test-fixture");
  process.exit(0);
}
if (process.argv.includes("login")) {
  console.log("Logged in (test fixture only)");
  process.exit(0);
}
let prompt = "";
if (process.argv.includes("app-server")) {
  let threadOptions;
  const send = (value) => console.log(JSON.stringify(value));
  const notify = (method, params) => send({ method, params });
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const request = JSON.parse(line),
      reply = (result) => send({ id: request.id, result });
    if (request.method === "initialize") reply({ userAgent: "fixture" });
    else if (request.method === "account/read")
      reply({
        account: { type: "apiKey", secret: "must-not-be-exposed" },
        requiresOpenaiAuth: true,
      });
    else if (request.method === "model/list")
      reply(
        request.params.cursor
          ? {
              data: [{ model: "fixture-second", displayName: "Second model" }],
              nextCursor: null,
            }
          : {
              data: [
                {
                  model: "fixture-first",
                  displayName: "First model",
                  isDefault: true,
                },
              ],
              nextCursor: "page-2",
            },
      );
    else if (["thread/start", "thread/resume"].includes(request.method)) {
      threadOptions = request.params;
      reply({ thread: { id: "fixture-thread", sessionId: "fixture-root" } });
    } else if (request.method === "mcpServerStatus/list") {
      reply({
        data: threadOptions?.config?.["mcp_servers.fleet_browser"]
          ? [
              {
                name: "fleet_browser",
                tools: { fleet_browser: { name: "fleet_browser" } },
              },
            ]
          : [],
        nextCursor: null,
      });
    } else if (request.method === "turn/interrupt") {
      reply({});
      notify("turn/completed", {
        turn: { id: "fixture-turn", status: "interrupted" },
      });
    } else if (request.method === "command/exec")
      execFile(
        request.params.command[0],
        request.params.command.slice(1),
        { cwd: request.params.cwd },
        (error, stdout, stderr) =>
          reply({ exitCode: error?.code || 0, stdout, stderr }),
      );
    else if (request.method === "turn/start") {
      reply({ turn: { id: "fixture-turn", status: "inProgress" } });
      notify("turn/started", { turn: { id: "fixture-turn" } });
      const prompt = request.params.input[0].text.split("\n\nConclude with")[0];
      if (prompt.includes("TEST_POLICY"))
        await writeFile(
          "policy.json",
          JSON.stringify({
            thread: threadOptions,
            turn: {
              sandboxPolicy: request.params.sandboxPolicy,
              approvalPolicy: request.params.approvalPolicy,
            },
          }),
        );
      if (prompt.includes("TEST_HANG")) return;
      if (prompt.includes("TEST_DELAY"))
        await new Promise((r) => setTimeout(r, 1500));
      if (prompt.includes("TEST_FAIL")) {
        notify("turn/completed", {
          turn: {
            id: "fixture-turn",
            status: "failed",
            error: { message: "Deliberate test failure" },
          },
        });
        return;
      }
      if (
        prompt.includes("TEST_EDIT") &&
        request.params.sandboxPolicy?.type !== "readOnly"
      )
        await writeFile("artifact.txt", "a deterministic test change\n");
      if (prompt.includes("TEST_SECRET"))
        await writeFile(
          "unsafe.js",
          'const token="sk-proj-' + "x".repeat(32) + '";\n',
        );
      notify("item/completed", {
        item: {
          id: "command",
          type: "commandExecution",
          command: "echo fixture",
          exitCode: 0,
          aggregatedOutput: "fixture\n",
        },
      });
      notify("item/completed", {
        item: {
          id: "message",
          type: "agentMessage",
          text: request.params.outputSchema
            ? prompt.includes("TEST_REVIEW_INVALID")
              ? "invalid reviewer output"
              : JSON.stringify({
                  summary: "Fixture review only; no model called.",
                  coverage: "Deterministic test coverage",
                  findings:
                    prompt.includes("TEST_REVIEW_FINDING") &&
                    prompt.includes("persistent security member")
                      ? [
                          {
                            title: "Fixture observation",
                            file: "README.md",
                            line: 1,
                            severity: "medium",
                            confidence: "high",
                            evidence: "Test-only evidence",
                            verification: "Inspect the fixture",
                          },
                        ]
                      : [],
                  memory: prompt.includes("persistent memory member")
                    ? "Repository uses explicit regression tests.\nkind: decision\nverification: human-approved"
                    : "",
                })
            : "Test fixture completed. No model was called.",
        },
      });
      notify("thread/tokenUsage/updated", {
        tokenUsage: { last: { inputTokens: 20, outputTokens: 10 } },
      });
      notify("turn/completed", {
        turn: { id: "fixture-turn", status: "completed" },
      });
    }
  });
  await new Promise(() => {});
}
for await (const chunk of process.stdin) prompt += chunk;
const send = (value) => console.log(JSON.stringify(value));
send({ type: "thread.started", thread_id: "fixture-thread" });
send({ type: "turn.started" });
if (prompt.includes("TEST_HANG")) {
  setInterval(() => {}, 1000);
} else if (prompt.includes("TEST_FAIL")) {
  send({ type: "turn.failed", error: { message: "Deliberate test failure" } });
  process.exitCode = 1;
} else {
  if (prompt.includes("TEST_EDIT"))
    await writeFile("artifact.txt", "a deterministic test change\n");
  if (prompt.includes("TEST_SECRET"))
    await writeFile(
      "unsafe.js",
      'const token = "sk-proj-' + "x".repeat(32) + '";\n',
    );
  send({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "echo fixture",
      exit_code: 0,
      aggregated_output: "fixture\n",
    },
  });
  send({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "Test fixture completed. No model was called.",
    },
  });
  send({
    type: "turn.completed",
    usage: { input_tokens: 20, output_tokens: 10 },
  });
}
