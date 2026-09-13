import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JSDOM } from "jsdom";
import {
  createNativePageAgent,
  pageOperation,
} from "../desktop/native-page-agent.mjs";
import { browserURL } from "../server/browser-network.mjs";
import { validateNativeAction } from "../shared/native-browser-actions.mjs";

function fixture(result) {
  const web = new EventEmitter();
  web.isDestroyed = () => false;
  web.getURL = () => "https://search.example/results";
  web.executeJavaScriptInIsolatedWorld = async () => ({ value: result });
  return createNativePageAgent({
    web,
    browserURL,
    forbiddenPorts: [4317, 45678],
    validateAction: validateNativeAction,
  });
}

test("native page snapshots resolve link destinations against the document", (t) => {
  const dom = new JSDOM(
    '<a href="/products/navy-suit">Navy suit</a><a href="javascript:alert(1)">Bad</a>',
    { url: "https://shop.example/search?q=suit" },
  );
  const originals = Object.fromEntries(
    [
      "window",
      "document",
      "location",
      "getComputedStyle",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  });
  for (const element of dom.window.document.querySelectorAll("a"))
    element.getBoundingClientRect = () => ({ width: 100, height: 20 });

  const snapshot = pageOperation({
    action: "snapshot",
    nonce: "123",
    generation: 0,
  });
  assert.deepEqual(snapshot.elements, ["@e1231 a Navy suit", "@e1232 a Bad"]);
  assert.deepEqual(snapshot.links, {
    "@e1231": "https://shop.example/products/navy-suit",
    "@e1232": "javascript:alert(1)",
  });

  const link = dom.window.document.querySelector("a");
  link.scrollIntoView = () => {};
  dom.window.document.elementFromPoint = () => dom.window.document.body;
  assert.throws(
    () =>
      pageOperation({
        action: "click",
        target: "@e1231",
        generation: 0,
      }),
    /use navigate with that URL instead of retrying the click or pressing Tab/,
  );
});

test("native snapshots expose only URL-policy-valid link destinations", async (t) => {
  const agent = fixture({
    title: "Results",
    url: "https://search.example/results",
    text: "A result",
    elements: ["@e1 a A result"],
    links: {
      "@e1": "https://shop.example/item?id=1",
      "@e2": "javascript:alert(1)",
      "@e3": "file:///etc/passwd",
      "@e4": "https://user:secret@shop.example/private",
      "@e5": "http://127.0.0.1:4317/api/state",
      invalid: "https://shop.example/not-a-reference",
    },
    scope: "fixture",
  });
  t.after(() => agent.close());

  const snapshot = await agent.execute({ action: "snapshot" });
  assert.deepEqual(snapshot.links, {
    "@e1": "https://shop.example/item?id=1",
  });
  assert.deepEqual(snapshot.elements, ["@e1 a A result"]);
});

test("native snapshot filtering does not replace navigate URL enforcement", async (t) => {
  const agent = fixture({});
  t.after(() => agent.close());

  await assert.rejects(
    agent.execute({ action: "navigate", url: "javascript:alert(1)" }),
    /HTTP\(S\)/,
  );
  await assert.rejects(
    agent.execute({
      action: "navigate",
      url: "http://127.0.0.1:4317/api/state",
    }),
    /internal services/,
  );
});

test("password fields can be filled for sign-in without returning their value; file pickers stay manual", (t) => {
  const dom = new JSDOM(
    '<label for="password">Password</label><input id="password" type="password"><input type="file" aria-label="Upload">',
    { url: "https://login.example/", pretendToBeVisual: true },
  );
  for (const key of [
    "window",
    "document",
    "location",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Event",
    "getComputedStyle",
  ]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === "window"
          ? dom.window
          : key === "getComputedStyle"
            ? dom.window.getComputedStyle.bind(dom.window)
            : dom.window[key],
    });
    t.after(() =>
      original
        ? Object.defineProperty(globalThis, key, original)
        : delete globalThis[key],
    );
  }
  t.after(() => dom.window.close());
  const password = dom.window.document.querySelector("#password");
  for (const el of dom.window.document.querySelectorAll("input")) {
    el.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 20,
    });
    el.scrollIntoView = () => {};
  }
  dom.window.document.elementFromPoint = () => password;
  const snapshot = pageOperation({
    action: "snapshot",
    nonce: "login",
    generation: 0,
  });
  const target = snapshot.elements[0].split(" ")[0];
  const events = [];
  password.addEventListener("input", () => events.push("input"));
  password.addEventListener("change", () => events.push("change"));
  const result = pageOperation({
    action: "fill",
    target,
    text: "fixture-password-only",
    generation: 0,
  });
  assert.equal(password.value, "fixture-password-only");
  assert.deepEqual(result, { filled: target });
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(
    JSON.stringify(
      pageOperation({ action: "snapshot", nonce: "after", generation: 0 }),
    ).includes("fixture-password-only"),
    false,
  );
  assert.throws(
    () =>
      pageOperation({
        action: "fill",
        target: "@eafter2",
        text: "/tmp/file",
        generation: 0,
      }),
    /Select files yourself/,
  );
});
