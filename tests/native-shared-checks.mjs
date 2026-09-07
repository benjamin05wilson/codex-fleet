import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export async function withNativeBrowserTool(check) {
  const pending = new Map();
  let sequence = 0;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FLEET_BROWSER_URL:
      process.env.FLEET_SHARED_TEST_ORIGIN + "/api/browser-agent",
    FLEET_BROWSER_CAPABILITY: process.env.FLEET_SHARED_TEST_CAPABILITY,
  };
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../server/browser-mcp.mjs", import.meta.url))],
    { env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line),
      p = pending.get(message.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(message.id);
      p.resolve(message.result);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native MCP fixture timed out"));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const call = async (input) => {
    const result = await rpc("tools/call", {
      name: "fleet_browser",
      arguments: input,
    });
    if (result.isError) throw new Error(result.content[0].text);
    if (result.content[0].type === "image") return result.content[0];
    return JSON.parse(result.content[0].text);
  };
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "native-fixture", version: "1" },
    });
    const list = await rpc("tools/list", {});
    assert.equal(list.tools[0].name, "fleet_browser");
    assert.equal(
      list.tools[0].inputSchema.properties.action.enum.includes("newTab"),
      false,
    );
    return await check(call);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Fixture closed"));
    }
  }
}

export async function checkNativeSharing({ web, action, pageURL, waitFor }) {
  await waitFor(async () => (await action("state")).agentConnected);
  return withNativeBrowserTool(async (call) => {
    await call({ action: "navigate", url: pageURL });
    const first = await call({ action: "snapshot" });
    const target = first.elements
      .find((line) => line.includes("input Name"))
      ?.split(" ")[0];
    assert.ok(target, "snapshot must expose the native page input");
    await call({ action: "fill", target, text: "agent entry" });
    assert.equal(
      await web.executeJavaScript(
        "document.querySelector('output').textContent",
      ),
      "agent entry",
    );
    // Native user input remains usable immediately after an agent action.
    await web.insertText(" + user");
    const combined = await web.executeJavaScript(
      "document.querySelector('input').value",
    );
    assert.ok(combined.includes("agent entry") && combined.includes("user"));
    await call({ action: "press", text: "Meta+a" });
    await call({ action: "press", text: "End" });
    const second = await call({ action: "snapshot" });
    await assert.rejects(
      call({ action: "fill", target, text: "stale" }),
      /fresh snapshot|changed/,
    );
    const link = second.elements
      .find((line) => line.includes("a Next"))
      ?.split(" ")[0];
    assert.ok(link);
    await call({ action: "click", target: link });
    await waitFor(() => web.getURL().endsWith("/next") && !web.isLoading());
    await action("back");
    await waitFor(() => web.getURL() === pageURL + "/" && !web.isLoading());
    await assert.rejects(
      call({ action: "fill", target, text: "stale after user navigation" }),
      /fresh snapshot|changed/,
    );
    await call({ action: "scroll", text: "down" });
    assert.ok(await web.executeJavaScript("scrollY > 0"));
    const screenshot = await call({ action: "screenshot" });
    assert.equal(screenshot.mimeType, "image/png");
    assert.ok(screenshot.data.length > 100);
    await assert.rejects(
      call({ action: "navigate", url: process.env.FLEET_SHARED_TEST_ORIGIN }),
      /internal/,
    );
    await assert.rejects(
      call({ action: "navigate", url: "file:///etc/passwd" }),
      /HTTP/,
    );
    await assert.rejects(
      call({ action: "eval", text: "process.env" }),
      /Unsupported/,
    );
    assert.equal(
      await web.executeJavaScript("typeof window.__fleetNativeElements"),
      "undefined",
      "agent references must be isolated from the website",
    );
    console.log(
      "PASS: real stdio MCP → native bridge → same visible page; agent navigation/click/fill/keys/scroll/screenshot, interleaved human input, stale refs and internal/file/eval rejection. No takeover or approval calls; no model calls.",
    );
  });
}
