// Detached execution owner. UI and daemon disconnects are not termination signals.
import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { limits } from "./limits.mjs";
import { CodexClient, sandboxPolicy } from "./codex-client.mjs";
import { redactValue, redact } from "./sentinel.mjs";
import { validatePermissions } from "../shared/permissions.mjs";
import {
  browserMcpConfig,
  browserInstructions,
  verifyBrowserTool,
} from "../shared/browser-tools.mjs";

const directory = process.argv[2];
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
// The unique attempt owns this directory exactly once, including after a crash.
closeSync(openSync(join(directory, "owner.lock"), "wx", 0o600));
let seq = 0,
  finished = false,
  turnId,
  threadId,
  interrupted = false,
  idle = false,
  commandBusy = false,
  timer,
  deadline;
let currentRun = config.run;
let bootstrapping = true;
let client = new CodexClient(config.bin, config.run.worktree, config.browser);
const append = (event) =>
  appendFileSync(
    join(directory, "events.jsonl"),
    JSON.stringify({ seq: ++seq, event: redactValue(event) }) + "\n",
    { mode: 0o600 },
  );
let heartbeatWarning = false;
const heartbeat = (extra) => {
  try {
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
    heartbeatWarning = false;
    return true;
  } catch (error) {
    // Windows security/indexing software can briefly hold status.json and make
    // its atomic replacement fail with EBUSY/EPERM. The previous heartbeat and
    // PID remain valid, so a transient publication failure must not kill the
    // execution owner.
    if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
    if (!heartbeatWarning) {
      heartbeatWarning = true;
      try {
        append({
          type: "worker.diagnostic",
          text: `Could not publish worker heartbeat (${error.code || "unknown"}); retrying.`,
        });
      } catch {}
    }
    return false;
  }
};
const finish = (code, error) => {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  clearTimeout(deadline);
  const child = client.child;
  let published = false;
  const publish = () => {
    if (published) return;
    published = true;
    append({
      type: "worker.exit",
      exitCode: code,
      interrupted,
      error: redact(error || ""),
    });
    heartbeat({ finished: true, exitCode: code });
    setTimeout(() => process.exit(code === 0 ? 0 : 1), 100).unref();
  };
  client.close();
  // The daemon uses worker.exit as its cleanup barrier. Publish it only after
  // the owned app-server has actually released the worktree (not merely after
  // taskkill has been launched on Windows).
  if (!child || child.exitCode !== null) publish();
  else {
    child.once("close", publish);
    setTimeout(publish, 5000);
  }
};
const stop = async () => {
  if (interrupted || finished) return;
  if (idle) {
    finish(0);
    return;
  }
  interrupted = true;
  if (threadId && turnId)
    await client
      .request("turn/interrupt", { threadId, turnId }, 3000)
      .catch(() => {});
  finish(null, "Execution interrupted.");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", (error) =>
  finish(1, error?.stack || error?.message || String(error)),
);
process.on("unhandledRejection", (error) =>
  finish(1, error?.stack || error?.message || String(error)),
);
heartbeat({ finished: false });
timer = setInterval(() => {
  heartbeat({ finished: false, idle });
  if (existsSync(join(directory, "stop"))) stop();
  if (idle && !commandBusy && existsSync(join(directory, "command.json")))
    resume().catch((error) =>
      finish(1, error?.stack || error?.message || String(error)),
    );
}, 500);
let usage = {};
const notification = ({ method, params: p }) => {
  if (method === "turn/started") {
    turnId = p.turn.id;
    append({ type: "turn.started" });
    append({ type: "worker.phase", phase: "Thinking" });
  } else if (
    method === "item/started" &&
    ["mcpToolCall", "commandExecution", "fileChange"].includes(p.item?.type)
  ) {
    append({ type: "item.started", item: p.item });
    append({
      type: "worker.phase",
      phase:
        p.item.type === "mcpToolCall"
          ? "Using tools"
          : p.item.type === "fileChange"
            ? "Editing files"
            : "Running command",
    });
  } else if (method === "thread/tokenUsage/updated") {
    const u = p.tokenUsage?.last || {};
    usage = {
      input_tokens: u.inputTokens || 0,
      output_tokens: u.outputTokens || 0,
      cached_input_tokens: u.cachedInputTokens || 0,
    };
  } else if (method === "item/completed") {
    append({ type: "worker.phase", phase: "Thinking" });
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
    if (!ok) finish(1, p.turn.error?.message);
    else {
      clearTimeout(deadline);
      deadline = undefined;
      turnId = undefined;
      idle = true;
      append({ type: "worker.idle" });
      heartbeat({ finished: false, idle: true });
    }
  } else if (method === "fleet/permissionDenied") {
    append({
      type: "permission.denied",
      message: "Additional permissions require a newly approved task.",
    });
  } else if (method === "item/agentMessage/delta")
    append({ type: "message.delta", itemId: p.itemId, delta: p.delta });
};
const bindClient = (owned) => {
  owned.on("diagnostic", (text) =>
    append({ type: "worker.diagnostic", text: redact(text).slice(-2000) }),
  );
  owned.on("closed", (error) => {
    if (owned === client && !bootstrapping && !finished)
      finish(1, error.message);
  });
  owned.on("notification", notification);
};
const replaceClient = () => {
  const previous = client;
  previous.removeAllListeners();
  previous.close();
  client = new CodexClient(config.bin, config.run.worktree, config.browser);
  bindClient(client);
};
bindClient(client);
const optionsFor = (run) => ({
  cwd: run.worktree,
  approvalPolicy: "never",
  sandbox: validatePermissions(run),
  developerInstructions: browserInstructions(!!config.browser),
  ...(run.model ? { model: run.model } : {}),
  config: {
    ...browserMcpConfig(config.browser).config,
    // This is a Fleet-worker override, not a change to the user's Codex config.
    // Desktop automation must not close/reconfigure Fleet to imitate browsing.
    "mcp_servers.cua_repl": {
      command: process.execPath,
      args: ["--version"],
      enabled: false,
    },
  },
});
const startTurn = async (prompt, run) => {
  idle = false;
  usage = {};
  heartbeat({ finished: false, idle: false });
  clearTimeout(deadline);
  deadline = setTimeout(stop, run.timeoutMs || limits.timeoutMs);
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: run.worktree,
    approvalPolicy: "never",
    sandboxPolicy: sandboxPolicy(run.worktree, run.sandbox),
    ...(run.outputSchema ? { outputSchema: run.outputSchema } : {}),
  });
};
const resume = async () => {
  if (!idle || commandBusy) return;
  commandBusy = true;
  try {
    const path = join(directory, "command.json");
    const command = JSON.parse(readFileSync(path, "utf8"));
    unlinkSync(path);
    if (
      command.identity !== config.identity ||
      command.run?.id !== config.run.id ||
      command.run?.worktree !== config.run.worktree ||
      typeof command.prompt !== "string" ||
      !command.prompt.trim() ||
      command.prompt.length > 100_000
    )
      throw new Error("Invalid durable worker command.");
    validatePermissions(command.run);
    if (command.run.model !== currentRun.model) {
      const result = await client.request("thread/resume", {
        ...optionsFor(command.run),
        threadId,
      });
      threadId = result.thread.id;
    }
    currentRun = command.run;
    append({ type: "worker.resumed", attempt: command.attempt });
    await startTurn(command.prompt, currentRun);
  } finally {
    commandBusy = false;
  }
};
const connect = async () => {
  try {
    return await client.connect();
  } catch (error) {
    if (!/Codex app-server exited \(/i.test(error.message)) throw error;
    append({
      type: "worker.diagnostic",
      text: "Codex app-server exited before initialization; retrying once.",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    replaceClient();
    return client.connect();
  }
};
const bootstrap = async () => {
  await connect();
  const open = async (resumeThread) => {
    const result = await client.request(
      resumeThread ? "thread/resume" : "thread/start",
      {
        ...optionsFor(currentRun),
        ...(resumeThread ? { threadId: currentRun.threadId } : {}),
      },
    );
    const nextThreadId = result.thread.id;
    if (config.browser) {
      append({ type: "worker.phase", phase: "Connecting project browser" });
      await verifyBrowserTool(client, nextThreadId);
    }
    return { result, threadId: nextThreadId };
  };
  try {
    return { ...(await open(!!currentRun.threadId)), replaced: false };
  } catch (error) {
    if (
      !currentRun.threadId ||
      !/Codex app-server exited \(/i.test(error.message)
    )
      throw error;
    append({
      type: "worker.diagnostic",
      text: "Saved Codex thread could not be resumed; starting a replacement before this turn.",
    });
    replaceClient();
    await connect();
    return { ...(await open(false)), replaced: true };
  }
};
try {
  append({ type: "worker.phase", phase: "Connecting to Codex" });
  const boot = await bootstrap();
  const result = boot.result;
  threadId = boot.threadId;
  bootstrapping = false;
  append({
    type: "thread.started",
    thread_id: threadId,
    session_id: result.thread.sessionId,
  });
  const prompt = boot.replaced
    ? `Fleet had to replace an unreadable saved Codex thread before this turn. Preserve continuity using this limited trusted session context:\nOriginal user task: ${(currentRun.prompt || "").slice(0, 6000)}\nPrior assistant handoff: ${(currentRun.summary || "None").slice(0, 8000)}\n\n${config.prompt}`
    : config.prompt;
  await startTurn(prompt, currentRun);
} catch (error) {
  bootstrapping = false;
  finish(1, error.message);
}
