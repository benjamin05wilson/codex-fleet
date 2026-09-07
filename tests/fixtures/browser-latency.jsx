import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectBrowser } from "../../src/features/browser.jsx";
import { api } from "../../src/ui.jsx";

await api("/state");
await api("/projects/latency/browser/take", "POST", {});
createRoot(document.getElementById("root")).render(
  <ProjectBrowser project={{ id: "latency", name: "Latency fixture" }} />,
);
// Test-only observer: decode the fixture's visual position barcode AFTER the
// real Fleet <img> finishes loading, including HTTP, React and image decoding.
window.latency = {
  inputs: [],
  paints: [],
  decodeMs: [],
  ready: false,
  timeOrigin: performance.timeOrigin,
};
const canvas = document.createElement("canvas");
canvas.width = 160;
canvas.height = 20;
const ctx = canvas.getContext("2d", { willReadFrequently: true });
let image, started;
new MutationObserver(() => {
  const next = document.querySelector('img[alt="Live project browser page"]');
  if (next && next !== image) {
    image = next;
    image.addEventListener("load", () => {
      ctx.drawImage(image, 0, 0, 160, 20, 0, 0, 160, 20);
      let y = 0;
      for (let bit = 0; bit < 16; bit++)
        if (ctx.getImageData(bit * 10 + 5, 10, 1, 1).data[1] > 120)
          y |= 1 << bit;
      window.latency.paints.push({ at: performance.now(), y });
      window.latency.decodeMs.push(performance.now() - started);
      window.latency.ready = true;
    });
  }
  started = performance.now();
}).observe(document.getElementById("root"), {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src"],
});
window.scrollTrial = async () => {
  const viewport = document.querySelector(".browser-viewport");
  window.latency.inputs = [];
  window.latency.paints = [];
  for (let i = 0; i < 90; i++) {
    window.latency.inputs.push({ at: performance.now(), y: (i + 1) * 8 });
    viewport.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 8,
        deltaX: 0,
      }),
    );
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 500));
  return window.latency;
};
