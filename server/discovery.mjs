import { CodexClient } from "./codex-client.mjs";
import { repository, safeRead } from "./git.mjs";
import { basename } from "node:path";

export async function inspectRepository(path) {
  const repo = await repository(path);
  let pkg;
  try {
    pkg = JSON.parse(await safeRead(repo.path, "package.json"));
  } catch {}
  const commands = [];
  if (pkg?.scripts?.test && !pkg.scripts.test.includes("no test specified")) {
    const manager =
      typeof pkg.packageManager === "string"
        ? pkg.packageManager.split("@")[0]
        : "npm";
    if (["npm", "pnpm", "yarn", "bun"].includes(manager))
      commands.push({
        command: `${manager} test`,
        source: "package.json scripts.test",
      });
  }
  return { ...repo, name: basename(repo.path), commands };
}

// A short-lived metadata connection. Never starts a model turn or returns credentials.
export async function discoverCodex(bin, cwd) {
  const client = new CodexClient(bin, cwd);
  try {
    await client.connect();
    const auth = await client.request("account/read", { refreshToken: false });
    const models = [],
      seen = new Set();
    let cursor;
    do {
      const page = await client.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data))
        throw new Error("Codex returned an invalid model catalogue.");
      for (const m of page.data)
        if (
          !m.hidden &&
          typeof m.model === "string" &&
          !models.some((v) => v.model === m.model)
        ) {
          models.push({
            model: m.model,
            displayName: m.displayName || m.model,
            isDefault: !!m.isDefault,
          });
        }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Codex repeated a model page.");
      seen.add(cursor);
      if (seen.size > 20)
        throw new Error("Codex model catalogue exceeded the page limit.");
    } while (cursor);
    return {
      models,
      accountType: auth.account?.type || null,
      authenticated: !!auth.account,
      requiresOpenaiAuth: auth.requiresOpenaiAuth,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.close();
  }
}
