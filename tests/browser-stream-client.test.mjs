import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../shared/client.mjs";

test("frame client authenticates, decodes split NDJSON and aborts on unsubscribe", async () => {
  let source, signal, headers;
  const client = createClient({
    clientId: "window-one",
    fetchImpl: async (url, options) => {
      signal = options.signal;
      headers = options.headers;
      return new Response(
        new ReadableStream({
          start(controller) {
            source = controller;
            signal.addEventListener("abort", () =>
              controller.error(new Error("Aborted")),
            );
          },
        }),
      );
    },
  });
  client.setToken("csrf-token");
  const frames = [];
  const stop = client.subscribe("/projects/p/browser/frames", (frame) =>
    frames.push(frame),
  );
  await new Promise((r) => setTimeout(r, 0));
  const encode = (text) => new TextEncoder().encode(text);
  source.enqueue(encode('{"seq":1,"image":"'));
  source.enqueue(encode('abc"}\n\n{"seq":2,"image":"def"}\n'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(frames, [
    { seq: 1, image: "abc" },
    { seq: 2, image: "def" },
  ]);
  assert.equal(headers["X-Fleet-Token"], "csrf-token");
  assert.equal(headers["X-Fleet-Client"], "window-one");
  stop();
  assert.equal(signal.aborted, true);
});
