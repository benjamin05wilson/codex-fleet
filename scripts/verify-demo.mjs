import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile),
  root = fileURLToPath(new URL("../", import.meta.url));
const scenarios = [
  ["durable-reconnection", "worker survives daemon detach"],
  ["approved-workflow", "approved workflow executes once"],
  ["security-lifecycle", "fixed file findings resolve"],
  ["terminal-ownership", "interactive terminal requires"],
  ["project-memory", "context is project-isolated"],
];
const results = [];
for (const [id, pattern] of scenarios) {
  const start = performance.now();
  let passed = true,
    error;
  try {
    await exec(
      process.execPath,
      ["--test", "--test-name-pattern=" + pattern, "tests/focused.test.mjs"],
      { cwd: root, timeout: 30000, maxBuffer: 2_000_000 },
    );
  } catch (e) {
    passed = false;
    error = e.stdout || e.message;
  }
  results.push({
    id,
    passed,
    elapsedMs: Math.round(performance.now() - start),
    modelCalls: 0,
    usage: "deterministic protocol fixture; not model-performance evidence",
    humanInterventions: 0,
    ...(error ? { error } : {}),
  });
  console.log(
    `${passed ? "PASS" : "FAIL"} ${id} (${results.at(-1).elapsedMs}ms)`,
  );
}
await mkdir(new URL("../.fleet/", import.meta.url), {
  recursive: true,
  mode: 0o700,
});
await writeFile(
  new URL("../.fleet/demo-verification.json", import.meta.url),
  JSON.stringify(
    {
      time: new Date().toISOString(),
      kind: "reproducible fixture verification",
      results,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
