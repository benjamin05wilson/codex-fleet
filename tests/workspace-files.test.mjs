import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectEntry } from "../server/workspace.mjs";

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "fleet-save-regression-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const project = { path };
  const save = (content, baseVersion = null, name = "example.txt") =>
    writeProjectEntry(project, {
      path: name,
      kind: "file",
      content,
      baseVersion,
    });
  return { project, path, save };
}

test("concurrent saves against one base version cannot silently overwrite", async (t) => {
  const { save, path } = await fixture(t);
  const initial = await save("original");
  const results = await Promise.allSettled([
    save("first edit", initial.version),
    save("second edit", initial.version),
  ]);
  const saved = results.filter((r) => r.status === "fulfilled");
  const conflicts = results.filter((r) => r.status === "rejected");
  assert.equal(saved.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.status, 409);
  assert.equal(
    await readFile(join(path, "example.txt"), "utf8"),
    saved[0].value.content,
  );
  const next = await save("resolved edit", saved[0].value.version);
  assert.equal(
    next.content,
    "resolved edit",
    "conflict must not poison the write queue",
  );
  assert.deepEqual(await readdir(path), ["example.txt"]);
});

test("simultaneous new files and aliased project objects share the write lock", async (t) => {
  const { project, path, save } = await fixture(t);
  const results = await Promise.allSettled([
    save("first"),
    writeProjectEntry(
      { ...project },
      {
        path: "example.txt",
        kind: "file",
        content: "second",
        baseVersion: null,
      },
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(
    await readFile(join(path, "example.txt"), "utf8"),
    results.find((r) => r.status === "fulfilled").value.content,
  );
});

test("independent file creation tolerates a shared new parent directory", async (t) => {
  const { save } = await fixture(t);
  await Promise.all([save("a", null, "src/a.js"), save("b", null, "src/b.js")]);
});

test("stale saves leave the current bytes intact and no staging file behind", async (t) => {
  const { save, path } = await fixture(t);
  const a = await save("initial");
  const b = await save("new current", a.version);
  await assert.rejects(save("stale", a.version), { status: 409 });
  assert.equal(await readFile(join(path, "example.txt"), "utf8"), b.content);
  assert.deepEqual(await readdir(path), ["example.txt"]);
});

test("save validation matches the byte limit used by the reader", async (t) => {
  const { save, path } = await fixture(t);
  await assert.rejects(
    save("😀".repeat(50_000), null, "new/file.txt"),
    /UTF-8 bytes/,
  );
  assert.deepEqual(await readdir(path), []);
});

test(
  "atomic replacement preserves executable mode on POSIX",
  { skip: process.platform === "win32" },
  async (t) => {
    const { save, path } = await fixture(t);
    const first = await save("#!/bin/sh\n");
    await chmod(join(path, "example.txt"), 0o755);
    await save("#!/bin/sh\nexit 0\n", first.version);
    assert.equal((await stat(join(path, "example.txt"))).mode & 0o777, 0o755);
  },
);

test("parent links are rejected without modifying the linked file", async (t) => {
  const { project, path, save } = await fixture(t);
  await save("keep", null, "real/example.txt");
  await symlink(
    join(path, "real"),
    join(path, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    writeProjectEntry(project, {
      path: "alias/example.txt",
      kind: "file",
      content: "overwrite",
      baseVersion: null,
    }),
    /parent path/,
  );
  assert.equal(await readFile(join(path, "real/example.txt"), "utf8"), "keep");
});
