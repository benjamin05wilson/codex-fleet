import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("desktop entry finishes loading before Electron becomes ready", () => {
  const entry = new URL("../desktop/main.mjs", import.meta.url).href;
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        return specifier === 'electron'
          ? { url: 'fleet-test:electron', shortCircuit: true }
          : next(specifier, context);
      },
      load(url, context, next) {
        return url === 'fleet-test:electron'
          ? { format: 'module', shortCircuit: true, source: \`
              export const app = {
                isPackaged: false,
                commandLine: { appendSwitch() {} },
                setName() {},
                requestSingleInstanceLock() { return true; },
                on() {},
                whenReady() { return new Promise(() => {}); }
              };
              export const BrowserWindow = class {};
              export const WebContentsView = class {};
              export const session = {};
              export const dialog = {};
              export const ipcMain = {};
            \` }
          : next(url, context);
      }
    });
    await import(${JSON.stringify(entry)});
    console.log('entry-loaded');
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /entry-loaded/);
});
