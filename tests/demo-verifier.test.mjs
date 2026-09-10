import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify, selectedResult } from "../scripts/verify-demo.mjs";

test("demo verifier fails closed when a renamed scenario selects no test", async () => {
  const output = await mkdtemp(join(tmpdir(), "fleet-verifier-"));
  try {
    assert.equal(
      await verify({
        output,
        patterns: [["missing", "intentionally nonexistent scenario"]],
      }),
      false,
    );
    const report = JSON.parse(await readFile(join(output, "report.json")));
    assert.equal(report.results[0].passed, false);
    assert.ok(report.commit);
    assert.ok(report.node);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
test("skips, todos, wrong identity and failed summaries cannot count as demo evidence", () => {
  const sample = (data = {}, success = true) =>
    [
      {
        type: "test:pass",
        data: { name: "expected", details: { type: "test" }, ...data },
      },
      { type: "test:summary", data: { success } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
  assert.equal(selectedResult(sample(), "expected").passed, true);
  for (const data of [{ skip: true }, { todo: true }, { name: "other" }])
    assert.equal(selectedResult(sample(data), "expected").passed, false);
  assert.equal(selectedResult(sample({}, false), "expected").passed, false);
  assert.equal(selectedResult("", "expected").passed, false);
});
