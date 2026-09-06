// Explicit integration check: invokes the installed app-server, never an LLM.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxCheck } from "../server/codex-client.mjs";
const root = await mkdtemp(join(tmpdir(), "fleet-sandbox-check-")),
  worktree = join(root, "worktree");
await mkdir(worktree);
try {
  const result = await sandboxCheck(
    process.env.FLEET_CODEX_BIN || "codex",
    worktree,
    "printf allowed > inside.txt; printf denied > ../outside.txt",
  );
  assert.equal(await readFile(join(worktree, "inside.txt"), "utf8"), "allowed");
  await assert.rejects(readFile(join(root, "outside.txt")), { code: "ENOENT" });
  assert.notEqual(result.exitCode, 0);
  console.log(
    "PASS installed Codex app-server: workspace writes allowed; out-of-worktree write denied. No model called.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
