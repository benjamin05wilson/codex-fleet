// Detached execution owner. UI and daemon disconnects are not termination signals.
import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { limits } from "./limits.mjs";
import { CodexClient, sandboxPolicy } from "./codex-client.mjs";
import { redactValue, redact } from "./sentinel.mjs";
import { validatePermissions } from "../shared/permissions.mjs";

const directory = process.argv[2];
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
// The unique attempt owns this directory exactly once, including after a crash.
closeSync(openSync(join(directory, "owner.lock"), "wx", 0o600));
let seq = 0,
  finished = false,
  turnId,
  threadId,
  interrupted = false;
const client = new CodexClient(config.bin, config.run.worktree);
const append = (event) =>
  appendFileSync(
    join(directory, "events.jsonl"),
    JSON.stringify({ seq: ++seq, event: redactValue(event) }) + "\n",
    { mode: 0o600 },
  );
const heartbeat = (extra) => {
  writeFileSync(
    join(directory, "status.tmp"),
    JSON.stringify({
      pid: process.pid,
      time: Date.now(),
      identity: config.identity,
      ...extra,
    }),
    { mode: 0o600 },
  );
  renameSync(join(directory, "status.tmp"), join(directory, "status.json"));
};
const finish = (code, error) => {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  clearTimeout(deadline);
  append({
    type: "worker.exit",
    exitCode: code,
    interrupted,
    error: redact(error || ""),
  });
  heartbeat({ finished: true, exitCode: code });
  client.close();
  setTimeout(() => process.exit(code === 0 ? 0 : 1), 100).unref();
};
const stop = async () => {
  if (interrupted || finished) return;
  interrupted = true;
  if (threadId && turnId)
    await client
      .request("turn/interrupt", { threadId, turnId }, 3000)
      .catch(() => {});
  finish(null, "Execution interrupted.");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
heartbeat({ finished: false });
const timer = setInterval(() => {
  heartbeat({ finished: false });
  if (existsSync(join(directory, "stop"))) stop();
}, 500);
const deadline = setTimeout(stop, config.timeoutMs || limits.timeoutMs);
let usage = {};
client.on("diagnostic", (text) =>
  append({ type: "worker.diagnostic", text: redact(text).slice(-2000) }),
);
client.on("closed", (error) => {
  if (!finished) finish(1, error.message);
});
client.on("notification", ({ method, params: p }) => {
  if (method === "turn/started") {
    turnId = p.turn.id;
    append({ type: "turn.started" });
  } else if (method === "thread/tokenUsage/updated") {
    const u = p.tokenUsage?.last || {};
    usage = {
      input_tokens: u.inputTokens || 0,
      output_tokens: u.outputTokens || 0,
      cached_input_tokens: u.cachedInputTokens || 0,
    };
  } else if (method === "item/completed") {
    const item = p.item;
    if (item.type === "agentMessage")
      append({
        type: "item.completed",
        item: { id: item.id, type: "agent_message", text: item.text },
      });
    else if (item.type === "commandExecution")
      append({
        type: "item.completed",
        item: {
          id: item.id,
          type: "command_execution",
          command: item.command,
          exit_code: item.exitCode,
          aggregated_output: item.aggregatedOutput,
        },
      });
    else append({ type: "item.completed", item });
  } else if (method === "turn/completed") {
    const ok = p.turn.status === "completed";
    append({
      type: ok ? "turn.completed" : "turn.failed",
      usage,
      error: p.turn.error,
    });
    finish(ok ? 0 : 1, p.turn.error?.message);
  } else if (method === "fleet/permissionDenied") {
    append({
      type: "permission.denied",
      message: "Additional permissions require a newly approved task.",
    });
  } else if (method === "item/agentMessage/delta")
    append({ type: "message.delta", itemId: p.itemId, delta: p.delta });
});
try {
  await client.connect();
  const run = config.run;
  const options = {
    cwd: run.worktree,
    approvalPolicy: "never",
    sandbox: validatePermissions(run),
    ...(run.model ? { model: run.model } : {}),
  };
  const result = await client.request(
    run.threadId ? "thread/resume" : "thread/start",
    { ...options, ...(run.threadId ? { threadId: run.threadId } : {}) },
  );
  threadId = result.thread.id;
  append({
    type: "thread.started",
    thread_id: threadId,
    session_id: result.thread.sessionId,
  });
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: config.prompt }],
    cwd: run.worktree,
    approvalPolicy: "never",
    sandboxPolicy: sandboxPolicy(run.worktree, run.sandbox),
    ...(run.outputSchema ? { outputSchema: run.outputSchema } : {}),
  });
} catch (error) {
  finish(1, error.message);
}
