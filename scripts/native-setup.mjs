import { chmod, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// node-pty's published macOS helper needs its executable bit restored.
if (process.platform === "darwin") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const helper = join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  await access(helper);
  await chmod(helper, 0o755);
}
