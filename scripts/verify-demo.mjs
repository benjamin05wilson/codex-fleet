import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import os from "node:os";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
export const scenarios = [
  [
    "durable-reconnection",
    "worker survives daemon detach; reconnect does not duplicate a turn or usage",
  ],
  [
    "approved-workflow",
    "approved workflow executes once, validates dependencies, and proposes completion without accepting",
  ],
  [
    "security-lifecycle",
    "fixed file findings resolve and reappear when the defect returns",
  ],
  [
    "terminal-ownership",
    "interactive terminal requires a single owner and invalidates checks",
  ],
  [
    "project-memory",
    "context is project-isolated, ranked, bounded, and excludes unapproved proposals",
  ],
];
export function selectedResult(stdout, expected) {
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const executed = events.filter(
    (e) =>
      ["test:pass", "test:fail"].includes(e.type) &&
      !e.data.skip &&
      !e.data.todo &&
      e.data.details?.type === "test",
  );
  const summary = events.findLast(
    (e) => e.type === "test:summary" && e.data.file === undefined,
  );
  const passed =
    executed.length === 1 &&
    executed[0].data.name === expected &&
    executed[0].type === "test:pass" &&
    summary?.data.success === true;
  return {
    passed,
    executedTests: executed.length,
    selectedNames: executed.map((e) => e.data.name),
  };
}
export async function verify({
  output = resolve(root, ".fleet/demo-verification"),
  patterns = scenarios,
} = {}) {
  // Snapshot provenance before generated output itself dirties a tracked report.
  const commit = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const dirty = !!(
    await exec("git", ["status", "--porcelain"], {
      cwd: root,
    })
  ).stdout.trim();
  await mkdir(output, { recursive: true });
  const sanitize = (s) =>
    s.split(root).join("<repo>/").split(os.tmpdir()).join("<temp>");
  const results = [];
  for (const [id, expected] of patterns) {
    const command = [
      "--test",
      "--test-reporter=./scripts/demo-reporter.mjs",
      "--test-name-pattern=" + expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "tests/focused.test.mjs",
    ];
    const start = performance.now();
    let stdout = "",
      stderr = "",
      error;
    try {
      ({ stdout, stderr } = await exec(process.execPath, command, {
        cwd: root,
        timeout: 30000,
        maxBuffer: 2_000_000,
      }));
    } catch (e) {
      stdout = e.stdout || "";
      stderr = e.stderr || "";
      error = e.message;
    }
    let selection = { passed: false, executedTests: 0, selectedNames: [] };
    try {
      selection = selectedResult(stdout, expected);
    } catch (e) {
      error ||= e.message;
    }
    await writeFile(join(output, id + ".jsonl"), sanitize(stdout));
    await writeFile(join(output, id + ".stderr.txt"), sanitize(stderr));
    results.push({
      id,
      expected,
      ...selection,
      passed: selection.passed && !error,
      processElapsedMs: Math.round(performance.now() - start),
      command: ["node", ...command],
      ...(error ? { error: sanitize(error) } : {}),
    });
    console.log(
      `${results.at(-1).passed ? "PASS" : "FAIL"} ${id}: ${selection.executedTests} executed test(s)`,
    );
  }
  const report = {
    time: new Date().toISOString(),
    commit,
    dirty,
    provenance: "commit and dirty status captured before verification",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    transport: "explicit deterministic Codex protocol fixture",
    meaning:
      "Real Fleet system tests; scripted agent output. Process durations are not model throughput. Model-call and human-intervention counters are not instrumented.",
    results,
  };
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return results.every((r) => r.passed);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === "--output"))
    throw new Error("Usage: node scripts/verify-demo.mjs [--output directory]");
  if (!(await verify(args.length ? { output: resolve(args[1]) } : {})))
    process.exitCode = 1;
}
