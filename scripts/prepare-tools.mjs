import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  access,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

// Release inputs are pinned, including integrity. Never execute a remote installer.
export const releases = {
  "win32-x64": [
    [
      "node",
      "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
      "sha256",
      "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
    ],
    [
      "git",
      "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip",
      "sha256",
      "56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e",
    ],
    [
      "codex",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.153.4-win32-x64.tgz",
      "sha512",
      "lMkB43kJZH0VFr+hoXc11qqR7QtQIbkr07ALgj4urKL1osNyUyuy1iXd3Vzz2iCYvBUCSw7I0l/W1cEPGx9euQ==",
    ],
  ],
  "darwin-arm64": [
    [
      "node",
      "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz",
      "sha256",
      "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
    ],
    [
      "codex",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.153.4-darwin-arm64.tgz",
      "sha512",
      "B1qhN3fa1ay0R0wGziXqgwSkB5icpYChNKHhtBHff/0UtSTC7z+l8aTtvMlGjH3E8HEvY3+njIJelM9CAAoVWg==",
    ],
  ],
};
export function verifyDownload(bytes, algorithm, expected) {
  const actual = createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
  if (actual !== expected)
    throw new Error("Dependency checksum mismatch; refusing to package it.");
}
export async function prepareTools(
  target,
  output = resolve("build/managed-tools"),
) {
  const assets = releases[target];
  if (!assets) throw new Error(`No verified dependency bundle for ${target}`);
  const signature = JSON.stringify({ target, assets });
  try {
    const previous = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    if (previous.signature === signature) {
      for (const file of previous.executables) await access(join(output, file));
      return;
    }
  } catch {}
  await mkdir(resolve(output, ".."), { recursive: true });
  const stage = await mkdtemp(resolve(output, "..", "fleet-tools-"));
  try {
    for (const [name, url, algorithm, expected] of assets) {
      console.log(`Preparing Fleet's bundled ${name} (${target})…`);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok)
        throw new Error(`${name} download failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      verifyDownload(bytes, algorithm, expected);
      const archive = join(
        stage,
        url.endsWith(".zip") ? `${name}.zip` : `${name}.tgz`,
      );
      await writeFile(archive, bytes);
      const destination = join(stage, name);
      await mkdir(destination);
      if (url.endsWith(".zip") && process.platform !== "win32")
        await exec("unzip", ["-q", archive, "-d", destination]);
      else
        await exec("tar", ["-xf", archive, "-C", destination], {
          windowsHide: true,
        });
      await rm(archive);
    }
    const win = target === "win32-x64";
    const executables = win
      ? [
          "node/node-v24.19.0-win-x64/node.exe",
          "git/cmd/git.exe",
          "codex/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ]
      : [
          "node/node-v24.19.0-darwin-arm64/bin/node",
          "codex/package/vendor/aarch64-apple-darwin/bin/codex",
        ];
    for (const file of executables) await access(join(stage, file));
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify({ signature, target, executables }, null, 2),
    );
    // Only the generated, fixed build output is replaced. Never a user tools directory.
    if (output !== resolve("build/managed-tools"))
      throw new Error("Unexpected tools output");
    await rm(output, { recursive: true, force: true });
    await rename(stage, output);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export default async function beforePack(context) {
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  await prepareTools(`${context.electronPlatformName}-${arch}`);
}
