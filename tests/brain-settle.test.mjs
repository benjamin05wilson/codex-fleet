import test from "node:test";
import assert from "node:assert/strict";
import { settleBrain } from "./helpers/settle-brain.mjs";

test("desktop smoke drains a generation enqueued during note reading despite matching writer text", async () => {
  const project = { id: "fixture" };
  const note = { content: "fixture text" };
  let generation = 1,
    status = "queued",
    reads = 0,
    drains = 0,
    writes = 0;
  const brain = {
    writer: {
      async drain() {
        writes++;
      },
    },
    async drain() {
      drains++;
      status = "complete";
    },
    async list() {
      if (++reads === 1) {
        generation++;
        status = "queued";
      }
      return [note];
    },
    status() {
      return { status, generation };
    },
  };
  const result = await settleBrain(
    brain,
    project,
    (n) => n.content === "fixture text",
  );
  assert.equal(result.written, note);
  assert.equal(drains, 2);
  assert.equal(writes, 2);
  assert.deepEqual(
    result.observations.map((o) => [o.status, o.generation]),
    [
      ["queued", 2],
      ["complete", 2],
    ],
  );
  assert.equal(brain.status().status, "complete");
});

test("desktop smoke fails within its batch bound with job diagnostics", async () => {
  let drains = 0;
  const brain = {
    writer: { async drain() {} },
    async drain() {
      drains++;
    },
    async list() {
      return [{ content: "fixture text" }];
    },
    status() {
      return {
        status: "queued",
        generation: 3,
        attempts: 1,
        retryAt: 123,
        error: "fixture failure",
      };
    },
  };
  await assert.rejects(
    settleBrain(brain, {}, () => true),
    (error) => {
      assert.match(error.message, /"status":"queued"/);
      assert.match(error.message, /"generation":3/);
      assert.match(error.message, /fixture failure/);
      return true;
    },
  );
  assert.equal(drains, 8);
  await assert.rejects(
    settleBrain(
      { ...brain, status: () => ({ status: "complete" }) },
      {},
      () => false,
      1,
    ),
    /"matched":false/,
  );
});
