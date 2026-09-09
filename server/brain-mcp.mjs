import { serveBrowserMcp } from "./browser-mcp.mjs";
import { brainTool } from "../shared/brain-tools.mjs";
// Shared framing/cancellation code, with a separate read-only tool and capability.
serveBrowserMcp({
  tool: brainTool,
  serverName: "fleet-brain",
  url: process.env.FLEET_BRAIN_URL,
  capability: process.env.FLEET_BRAIN_CAPABILITY,
  timeoutMs: 28000,
});
