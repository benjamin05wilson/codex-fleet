import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { createApp } from "./app.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(process.env.FLEET_DATA_DIR || join(root, ".fleet"));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const lock = join(dataDir, "daemon.lock");
try {
  const existing = Number(await readFile(lock, "utf8"));
  if (existing) {
    try {
      process.kill(existing, 0);
      throw new Error(`Fleet is already running (process ${existing}).`);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  await unlink(lock);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const handle = await open(lock, "wx", 0o600);
await handle.writeFile(String(process.pid));
await handle.close();
const concurrency = Number(process.env.FLEET_CONCURRENCY || 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  throw new Error("FLEET_CONCURRENCY must be an integer from 1 to 16.");
const app = await createApp({
  dataDir,
  staticDir: join(root, "dist"),
  concurrency,
});
const port = Number(process.env.FLEET_PORT || 4317);
app.server.on("error", async (e) => {
  console.error(e.message);
  app.engine.shutdown();
  await unlink(lock).catch(() => {});
  process.exit(1);
});
app.server.listen(port, "127.0.0.1", () =>
  console.log(
    `\nFleet is running at http://127.0.0.1:${port}\nLocal data: ${dataDir}\n`,
  ),
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close({ preserveWorkers: true });
  setTimeout(async () => {
    app.store.close();
    await unlink(lock).catch(() => {});
    process.exit(0);
  }, 4000);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
