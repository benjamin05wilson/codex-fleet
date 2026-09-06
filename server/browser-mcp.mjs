// Dedicated per-attempt stdio MCP adapter. The model never receives the broker capability.
import { createInterface } from "node:readline";
import { browserTool } from "../shared/browser-tools.mjs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (line.length > 100000) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "initialize")
    return reply({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fleet-browser", version: "0.1.0" },
    });
  if (request.method === "ping") return reply({});
  if (request.method === "tools/list") return reply({ tools: [browserTool] });
  if (
    request.method !== "tools/call" ||
    request.params?.name !== browserTool.name
  )
    return send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Unsupported browser tool." },
    });
  try {
    const response = await fetch(process.env.FLEET_BROWSER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.FLEET_BROWSER_CAPABILITY,
      },
      body: JSON.stringify(request.params.arguments),
      signal: AbortSignal.timeout(85000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Browser request failed.");
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
    reply({ content: [{ type: "text", text: error.message }], isError: true });
  }
});
