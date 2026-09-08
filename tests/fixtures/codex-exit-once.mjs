#!/usr/bin/env node
// Fails the first app-server launch for a worktree, then delegates to the
// deterministic fixture. This verifies safe startup retry before any turn.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.includes("app-server")) {
  const identity = createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 24);
  const marker = join(tmpdir(), `fleet-codex-exit-once-${identity}`);
  if (!existsSync(marker)) {
    await writeFile(marker, "retry");
    process.exit(1);
  }
  await unlink(marker).catch(() => {});
}

await import("./codex.mjs");
