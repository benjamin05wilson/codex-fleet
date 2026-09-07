// Opt-in protocol test against installed Codex. Never sends turn/start or calls a model.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "../server/codex-client.mjs";
import {
  browserMcpConfig,
  verifyBrowserTool,
} from "../shared/browser-tools.mjs";
if (!process.argv.includes("--run")) {
  console.log(
    "Run with --run to verify installed Codex browser tool attachment without a model call.",
  );
  process.exit(0);
}
const cwd = await mkdtemp(join(tmpdir(), "fleet-browser-tools-"));
const browser = browserMcpConfig({
  node: process.execPath,
  script: fileURLToPath(new URL("../server/browser-mcp.mjs", import.meta.url)),
  url: "http://127.0.0.1:1/unused-no-tool-execution",
  token: "test-only-no-broker-capability",
});
const options = {
  cwd,
  approvalPolicy: "never",
  sandbox: "read-only",
  config: {
    ...browser.config,
    "mcp_servers.cua_repl": {
      command: process.execPath,
      args: ["--version"],
      enabled: false,
    },
  },
};
let client = new CodexClient(process.env.FLEET_CODEX_BIN || "codex", cwd);
let threadId;
try {
  await client.connect();
  const first = await client.request("thread/start", {
    ...options,
    ephemeral: true,
  });
  threadId = first.thread.id;
  await verifyBrowserTool(client, threadId);
  console.log(
    "PASS: installed Codex discovers fleet_browser before a model turn. No model calls; persisted-thread resume is covered only by fixtures.",
  );
} finally {
  client.close();
  console.log("Isolated test directory: " + cwd);
}
