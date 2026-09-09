import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { acquireDaemonLock } from "./daemon-lock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(process.env.FLEET_DATA_DIR || join(root, ".fleet"));
const concurrency = Number(process.env.FLEET_CONCURRENCY || 3);
const port = Number(process.env.FLEET_PORT || 4317);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  throw new Error("FLEET_CONCURRENCY must be an integer from 1 to 16.");
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("FLEET_PORT must be an integer from 0 to 65535.");

const lease = acquireDaemonLock(dataDir);
let app,
  closing = false;
try {
  app = await createApp({
    dataDir,
    staticDir: join(root, "dist"),
    concurrency,
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "127.0.0.1", resolve);
  });
  console.log(
    `\nFleet is running at http://127.0.0.1:${app.server.address().port}\nLocal data: ${dataDir}\n`,
  );
} catch (error) {
  if (app) {
    await app.close({ preserveWorkers: true }).catch(() => {});
    app.store.close();
  }
  lease.release();
  throw error;
}

async function stop(code = 0) {
  if (closing) return;
  closing = true;
  try {
    await app.close({ preserveWorkers: true });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    app.store.close();
  } catch (error) {
    console.error(error.message);
    code = 1;
  } finally {
    lease.release();
    process.exit(code);
  }
}
app.server.on("error", (error) => {
  console.error(error.message);
  void stop(1);
});
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
