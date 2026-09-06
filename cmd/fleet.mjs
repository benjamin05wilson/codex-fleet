#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createClient } from "../shared/client.mjs";
const args = process.argv.slice(2),
  json = args.includes("--json");
const [command, subject, ...rest] = args.filter((a) => a !== "--json");
const base = process.env.FLEET_URL || "http://127.0.0.1:4317";
const target = new URL(base);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.protocol !== "http:"
)
  throw new Error("Fleet CLI only connects to a local daemon.");
const client = createClient({ base: base + "/api" });
const output = (value) =>
  console.log(
    json
      ? JSON.stringify(value)
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2),
  );
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
try {
  if (!command || ["help", "--help"].includes(command)) {
    output(
      "Fleet\n  doctor | projects | list [--json]\n  new PROJECT_ID --title TITLE --task TASK [--write] [--start]\n  resume RUN_ID [--task FOLLOWUP] | stop RUN_ID\n  attach RUN_ID (open desktop/browser session)\n  review RUN_ID [--checks | --accept]\n  workflow run PROJECT_ID --file plan.json [--approve]\n  daemon (start foreground service)\nSet FLEET_URL for a non-default local port.",
    );
  } else if (command === "daemon") {
    await import("../server/index.mjs");
  } else {
    const state = await client.request("/state");
    if (command === "doctor")
      output({
        node: process.version,
        ...state.status,
        capabilities: await client.request("/capabilities"),
      });
    else if (command === "projects")
      output(state.projects.map(({ id, name, path }) => ({ id, name, path })));
    else if (command === "list")
      output(
        state.runs.map(({ id, title, status, projectId, blockedReason }) => ({
          id,
          title,
          status,
          projectId,
          blockedReason,
        })),
      );
    else if (command === "new") {
      const run = await client.request(`/projects/${subject}/runs`, "POST", {
        title: flag("--title", ""),
        prompt: flag("--task", ""),
        sandbox: args.includes("--write") ? "workspace-write" : "read-only",
        scopes: flag("--scope", "").split(",").filter(Boolean),
      });
      output(
        args.includes("--start")
          ? await client.request(`/runs/${run.id}/start`, "POST", {})
          : run,
      );
    } else if (command === "resume")
      output(
        await client.request(`/runs/${subject}/start`, "POST", {
          prompt: flag("--task", undefined),
        }),
      );
    else if (command === "stop")
      output(await client.request(`/runs/${subject}/pause`, "POST", {}));
    else if (command === "review")
      output(
        await client.request(
          `/runs/${subject}/${args.includes("--accept") ? "accept" : args.includes("--checks") ? "validate" : "diff"}`,
          args.includes("--accept") || args.includes("--checks")
            ? "POST"
            : "GET",
          args.includes("--accept") || args.includes("--checks")
            ? {}
            : undefined,
        ),
      );
    else if (command === "attach") {
      if (!state.runs.some((r) => r.id === subject))
        throw new Error("Session not found.");
      const url = base + "/#session=" + encodeURIComponent(subject);
      if (json) output({ url });
      else {
        const p = spawn("open", [url], { stdio: "ignore" });
        p.on("error", (e) => {
          console.error(e.message);
          process.exitCode = 1;
        });
      }
    } else if (command === "workflow" && subject === "run") {
      const input = JSON.parse(await readFile(flag("--file", ""), "utf8"));
      const workflow = await client.request(
        `/projects/${rest[0]}/workflows`,
        "POST",
        input,
      );
      output(
        args.includes("--approve")
          ? await client.request(
              `/workflows/${workflow.id}/approve`,
              "POST",
              {},
            )
          : workflow,
      );
    } else throw new Error("Unknown command. Run fleet help.");
  }
} catch (error) {
  console.error(
    json ? JSON.stringify({ error: error.message }) : error.message,
  );
  process.exitCode = 1;
}
