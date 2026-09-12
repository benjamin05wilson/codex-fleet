import test from "node:test";
import assert from "node:assert/strict";
import { writeClipboard } from "../desktop/clipboard.mjs";

test("desktop clipboard accepts only text from Fleet's own main frame", async () => {
  const origin = "http://127.0.0.1:4317";
  const mainFrame = { url: origin + "/#session=example" };
  const window = { isDestroyed: () => false, webContents: { mainFrame } };
  const event = { sender: window.webContents, senderFrame: mainFrame };
  const writes = [];
  const clipboard = { writeText: async (text) => writes.push(text) };
  await writeClipboard(event, "line one\nline two", window, origin, clipboard);
  assert.deepEqual(writes, ["line one\nline two"]);
  for (const untrusted of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: origin } },
    { ...event, senderFrame: null },
  ])
    await assert.rejects(
      writeClipboard(untrusted, "bad", window, origin, clipboard),
      /Untrusted/,
    );
  mainFrame.url = "https://example.com/";
  await assert.rejects(
    writeClipboard(event, "bad", window, origin, clipboard),
    /Untrusted/,
  );
  mainFrame.url = origin;
  await assert.rejects(
    writeClipboard(event, {}, window, origin, clipboard),
    /text is required/,
  );
  await assert.rejects(
    writeClipboard(event, "bad", null, origin, clipboard),
    /Untrusted/,
  );
  assert.equal(writes.length, 1);
});
test("desktop clipboard propagates native write failures", async () => {
  const mainFrame = { url: "http://127.0.0.1:4317" };
  const window = { isDestroyed: () => false, webContents: { mainFrame } };
  await assert.rejects(
    writeClipboard(
      { sender: window.webContents, senderFrame: mainFrame },
      "code",
      window,
      mainFrame.url,
      {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    ),
    /Clipboard unavailable/,
  );
});
