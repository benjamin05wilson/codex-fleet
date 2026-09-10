import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../server/git.mjs";
import { GitBlobs } from "../server/git-blobs.mjs";

test("snapshot blob reader reuses one process and preserves exact byte framing", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-git-blobs-"));
  const reader = new GitBlobs(root);
  try {
    await git(root, ["init"]);
    const values = [
      "",
      "line\n\n",
      "payment £ 😀\n".repeat(5000),
      "binary\0body\n",
    ];
    let pid;
    for (const [index, value] of values.entries()) {
      const path = join(root, `${index}.txt`);
      await writeFile(path, value);
      const object = (await git(root, ["hash-object", "-w", path])).trim();
      assert.equal(
        await reader.read(object, Buffer.byteLength(value), 512000),
        value,
      );
      pid ||= reader.child.pid;
      assert.equal(reader.child.pid, pid, "all blobs share the same process");
    }
    await reader.close();
    assert.equal(reader.child.stdout.destroyed, true);
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot blob reader rejects over-budget requests and mismatched object metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-git-blobs-limit-"));
  const reader = new GitBlobs(root);
  try {
    await assert.rejects(reader.read("HEAD:secret", 4, 10), /Invalid/);
    await assert.rejects(reader.read("0".repeat(40), 11, 10), /over-budget/);
    assert.equal(
      reader.child,
      undefined,
      "invalid requests must not launch Git",
    );
    await git(root, ["init"]);
    const path = join(root, "body");
    // Larger than a pipe chunk: protocol rejection leaves unread stdout.
    // Cleanup must close that paused iterator, not wait forever for EOF.
    await writeFile(path, "bounded".repeat(30000));
    const object = (await git(root, ["hash-object", "-w", path])).trim();
    await assert.rejects(
      reader.read(object, 1, 10),
      /identity, type or size changed/,
    );
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
