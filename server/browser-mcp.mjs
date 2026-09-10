// Persistent stdio MCP adapter. The model never receives the broker capability.
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserTool } from "../shared/browser-tools.mjs";

export function serveBrowserMcp({
  input = process.stdin,
  output = process.stdout,
  url = process.env.FLEET_BROWSER_URL,
  capability = process.env.FLEET_BROWSER_CAPABILITY,
  timeoutMs = 85000,
  timers = { setTimeout, clearTimeout },
  tool = browserTool,
  serverName = "fleet-browser",
} = {}) {
  const pending = new Map();
  let closed = false;
  const send = (value) => {
    if (!closed && !output.destroyed)
      output.write(JSON.stringify(value) + "\n");
  };
  const lines = createInterface({ input });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    lines.close();
    output.off("close", close);
    output.off("error", close);
  };
  lines.once("close", close);
  output.once("close", close);
  output.once("error", close);
  lines.on("line", async (line) => {
    if (closed || line.length > 100000) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (!request || typeof request !== "object") return;
    if (request.method === "notifications/cancelled") {
      pending.get(request.params?.requestId)?.abort();
      return;
    }
    if (request.id === undefined) return;
    const reply = (result) => send({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize")
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "0.1.0" },
      });
    if (request.method === "ping") return reply({});
    if (request.method === "tools/list") return reply({ tools: [tool] });
    if (request.method !== "tools/call" || request.params?.name !== tool.name)
      return send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unsupported browser tool." },
      });
    if (pending.has(request.id))
      return send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32600,
          message: "Browser request ID is already active.",
        },
      });
    const controller = new AbortController();
    pending.set(request.id, controller);
    const timer = timers.setTimeout(
      () =>
        controller.abort(
          new Error(
            "Browser request timed out. An in-flight action may have completed; inspect the page before retrying.",
          ),
        ),
      timeoutMs,
    );
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + capability,
        },
        body: JSON.stringify(request.params.arguments),
        signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || "Browser request failed.");
      if (controller.signal.aborted) return;
      reply(
        value.image
          ? {
              content: [
                { type: "image", data: value.image, mimeType: "image/png" },
              ],
              isError: false,
            }
          : {
              content: [{ type: "text", text: JSON.stringify(value) }],
              isError: false,
            },
      );
    } catch (error) {
      reply({
        content: [{ type: "text", text: error.message }],
        isError: true,
      });
    } finally {
      timers.clearTimeout(timer);
      pending.delete(request.id);
    }
  });
  return close;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  serveBrowserMcp();
