// Opt-in, isolated real Fleet React -> HTTP -> full Chrome -> decoded image trial.
// No personal profiles, user sessions or model calls. --shopify opts into
// Shopify's public home page in a separate temporary browser profile.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { createApp } from "../server/app.mjs";
import { launchOwnedChrome } from "../server/owned-chrome.mjs";
import { createBrowserProxy } from "../server/browser-network.mjs";
if (!process.argv.includes("--run")) {
  console.log("Use --run for an isolated full input-to-decoded-frame trial.");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "fleet-latency-"));
const fixture = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<style>body{margin:0;height:12000px;background:repeating-linear-gradient(125deg,#345 0px,#789 1px,#a54 3px,#367 4px)}canvas{position:fixed;left:0;top:0}</style><canvas width="160" height="20"></canvas><script>
  const c=document.querySelector('canvas').getContext('2d');function paint(){for(let i=0;i<16;i++){c.fillStyle=(Math.round(scrollY)&(1<<i))?'#00ff00':'#000';c.fillRect(i*10,0,10,20);}}addEventListener('scroll',paint);paint();</script>`);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
async function testConnection(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  socket.onmessage = ({ data }) => {
    const v = JSON.parse(data),
      p = pending.get(v.id);
    if (!p) return;
    pending.delete(v.id);
    clearTimeout(p.timer);
    v.error ? p.reject(new Error(v.error.message)) : p.resolve(v.result);
  };
  return { socket, call };
}
let app, chrome, proxy, socket, sourceSocket, sourceEvaluate;
try {
  await build({
    configFile: false,
    root,
    logLevel: "error",
    build: {
      outDir: join(dataDir, "ui"),
      emptyOutDir: false,
      rollupOptions: {
        input: join(root, "tests/fixtures/browser-latency.html"),
      },
    },
  });
  app = await createApp({
    dataDir,
    staticDir: join(dataDir, "ui"),
    browserOptions: { legacyFrames: process.argv.includes("--legacy-stream") },
  });
  app.store.put("project", {
    id: "latency",
    name: "Latency fixture",
    path: dataDir,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  await app.browsers.start(
    "latency",
    {
      url: process.argv.includes("--shopify")
        ? "https://www.shopify.com"
        : `http://127.0.0.1:${fixture.address().port}`,
      mode: "visible",
      approved: true,
    },
    "setup",
  );
  if (process.argv.includes("--shopify")) {
    const session = app.browsers.sessions.get("latency");
    const source = await testConnection(session.native.endpoint);
    sourceSocket = source.socket;
    const { tabs } = await app.browsers.command(session, ["tab", "list"]);
    const { sessionId } = await source.call("Target.attachToTarget", {
      targetId: tabs.find((t) => t.active).targetId,
      flatten: true,
    });
    sourceEvaluate = async (expression) => {
      const result = await source.call(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (result.exceptionDetails)
        throw new Error(
          "Isolated video diagnostic failed: " + result.exceptionDetails.text,
        );
      return result.result.value;
    };
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const result = await source.call(
        "Runtime.evaluate",
        {
          expression:
            "document.readyState === 'complete' && document.documentElement.scrollHeight > 2000",
          returnByValue: true,
        },
        sessionId,
      );
      if (result.result.value) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      ready,
      "Public Shopify page did not finish loading a scrollable document",
    );
    // Only the isolated test page gets this visual measurement overlay. No
    // page consent, login, challenge or site content is changed.
    const result = await source.call(
      "Runtime.evaluate",
      {
        expression: `(() => {
      scrollTo(0,0);const canvas=document.createElement('canvas');canvas.width=160;canvas.height=20;
      canvas.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';document.body.append(canvas);
      const c=canvas.getContext('2d');function paint(){for(let i=0;i<16;i++){c.fillStyle=(Math.round(scrollY)&(1<<i))?'#00ff00':'#000';c.fillRect(i*10,0,10,20);}}
      addEventListener('scroll',paint);paint();return true;
    })()`,
        returnByValue: true,
      },
      sessionId,
    );
    assert.ok(
      result.result.value,
      "Could not initialise the isolated scroll marker",
    );
  }
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  proxy = await createBrowserProxy([origin], [4317]);
  const directory = join(dataDir, "renderer");
  await mkdir(directory);
  chrome = await launchOwnedChrome({
    directory,
    proxyPort: proxy.port,
    background: true,
  });
  const renderer = await testConnection(chrome.endpoint);
  socket = renderer.socket;
  const { call } = renderer;
  const { targetId } = await call("Target.createTarget", {
    url: origin + "/tests/fixtures/browser-latency.html",
  });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const evaluate = async (expression) => {
    const r = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evaluate("Boolean(window.latency?.ready)");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Fleet renderer did not display a decoded frame");
  if (process.argv.includes("--video")) {
    assert.ok(sourceEvaluate, "Use --shopify with --video");
    let playing = false;
    for (let i = 0; i < 100; i++) {
      playing = await sourceEvaluate(
        `Array.from(document.querySelectorAll('video')).some(v=>{const r=v.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0&&r.width>0&&!v.paused&&v.readyState===4&&v.currentTime>1;})`,
      );
      if (playing) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(playing, "No loaded, playing Shopify video in the viewport");
    await sourceEvaluate(`(() => {
      const video=Array.from(document.querySelectorAll('video')).find(v=>{const r=v.getBoundingClientRect();return r.top<innerHeight&&r.bottom>0&&r.width>0&&!v.paused&&v.readyState===4;});
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=20;
      canvas.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';document.body.append(canvas);
      const c=canvas.getContext('2d');window.fleetVideoTrial={frames:[],timeOrigin:performance.timeOrigin};
      function frame(at,metadata){const y=window.fleetVideoTrial.frames.length+1;window.fleetVideoTrial.frames.push({at,y,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames});for(let i=0;i<16;i++){c.fillStyle=(y&(1<<i))?'#00ff00':'#000';c.fillRect(i*10,0,10,20);}video.requestVideoFrameCallback(frame);}
      video.requestVideoFrameCallback(frame);return true;
    })()`);
    const inspectVideo = `Array.from(document.querySelectorAll('video')).map(v => {const r=v.getBoundingClientRect(),q=v.getVideoPlaybackQuality();return {visible:r.top<innerHeight&&r.bottom>0&&r.width>0,paused:v.paused,ready:v.readyState,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,total:q.totalVideoFrames,dropped:q.droppedVideoFrames};})`;
    const before = await sourceEvaluate(inspectVideo);
    const captures = [];
    const listener = (frame) => {
      if (frame?.image)
        captures.push({ at: frame.at, bytes: frame.image.length });
    };
    app.browsers.sessions.get("latency").frameListeners.add(listener);
    await evaluate("window.latency.paints=[];window.latency.decodeMs=[];");
    await new Promise((r) => setTimeout(r, 8000));
    const after = await sourceEvaluate(inspectVideo);
    const ui = await evaluate("window.latency");
    const video = await sourceEvaluate("window.fleetVideoTrial");
    const distinct = ui.paints.filter(
      (p, i) => p.y > 0 && p.y !== ui.paints[i - 1]?.y,
    );
    const stats = (frames) => {
      const gaps = frames
        .slice(1)
        .map((p, i) => p.at - frames[i].at)
        .sort((a, b) => a - b);
      return {
        frames: frames.length,
        gapMedian: gaps[Math.floor(gaps.length * 0.5)],
        gapP95: gaps[Math.floor(gaps.length * 0.95)],
        maxGap: Math.max(...gaps),
      };
    };
    console.log(
      JSON.stringify({
        videoBefore: before.filter((v) => v.visible),
        videoAfter: after.filter((v) => v.visible),
        source: stats(video.frames),
        captured: stats(captures),
        displayedMarker: stats(distinct),
        loadedImages: stats(ui.paints),
        bytesPerSecond: captures.reduce((n, f) => n + f.bytes, 0) / 8,
      }),
    );
  } else {
    const nativeFrames = [],
      dispatches = [];
    const pageSession = app.browsers.sessions.get("latency");
    const onFrame = pageSession.socket?.onmessage;
    if (onFrame)
      pageSession.socket.onmessage = (event) => {
        const v = JSON.parse(event.data);
        if (v.type === "frame")
          nativeFrames.push({ at: Date.now(), ...v.metadata });
        onFrame(event);
      };
    else
      pageSession.frameListeners.add((frame) => {
        if (frame?.image)
          nativeFrames.push({
            at: frame.at,
            timestamp: frame.capturedAt,
            scrollOffsetY: frame.scrollY,
          });
      });
    const originalInput = pageSession.native.pages.input;
    pageSession.native.pages.input = async (...args) => {
      const entry = { at: Date.now(), delta: args[0].deltaY };
      dispatches.push(entry);
      const value = await originalInput(...args);
      entry.done = Date.now();
      return value;
    };
    const result = await evaluate("window.scrollTrial()");
    const delays = result.inputs
      .map((input) => {
        const paint = result.paints.find(
          (p) => p.y >= input.y && p.at >= input.at,
        );
        return paint ? paint.at - input.at : null;
      })
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
    const last = result.paints.at(-1);
    assert.equal(
      last.y,
      720,
      "All requested scroll distance must reach the displayed frame",
    );
    assert.ok(delays.length >= 80);
    const gaps = result.paints
      .slice(1)
      .map((p, i) => p.at - result.paints[i].at)
      .sort((a, b) => a - b);
    const percentile = (a, p) =>
      Number(a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1));
    console.log({
      page: process.argv.includes("--shopify") ? "shopify" : "fixture",
      path: process.argv.includes("--legacy-stream") ? "legacy" : "direct",
      samples: delays.length,
      inputToDecodedFrameMedianMs: percentile(delays, 0.5),
      inputToDecodedFrameP95Ms: percentile(delays, 0.95),
      medianPaintGapMs: percentile(gaps, 0.5),
      paintedFrames: result.paints.length,
      scrollDistance: last.y,
    });
    console.log({
      nativeMetadata: nativeFrames[0],
      decodeMedianMs: percentile(
        result.decodeMs.sort((a, b) => a - b),
        0.5,
      ),
      dispatchCount: dispatches.length,
      ackMedianMs: percentile(
        dispatches
          .filter((d) => d.done)
          .map((d) => d.done - d.at)
          .sort((a, b) => a - b),
        0.5,
      ),
    });
    let distance = 0;
    const sent = dispatches.map((d) => ({
      ...d,
      y: (distance += d.delta || 0),
    }));
    const stages = {
      inputToDispatch: [],
      dispatchToCapture: [],
      captureToServer: [],
      serverToDecoded: [],
    };
    for (const input of result.inputs) {
      const absolute = input.at + result.timeOrigin;
      const dispatch = sent.find((d) => d.y >= input.y);
      const frame = nativeFrames.find(
        (f) => f.scrollOffsetY >= input.y && f.at >= absolute,
      );
      const paint = result.paints.find(
        (p) => p.y >= input.y && p.at >= input.at,
      );
      if (dispatch && frame && paint) {
        stages.inputToDispatch.push(dispatch.at - absolute);
        stages.dispatchToCapture.push(frame.timestamp - dispatch.at);
        stages.captureToServer.push(frame.at - frame.timestamp);
        stages.serverToDecoded.push(paint.at + result.timeOrigin - frame.at);
      }
    }
    console.log(
      Object.fromEntries(
        Object.entries(stages).map(([key, values]) => [
          key,
          {
            median: percentile(
              values.sort((a, b) => a - b),
              0.5,
            ),
            p95: percentile(values, 0.95),
          },
        ]),
      ),
    );
  }
} finally {
  socket?.close();
  sourceSocket?.close();
  await chrome?.close();
  await proxy?.close();
  if (app) {
    await app.close();
    app.store.close();
  }
  await new Promise((r) => fixture.close(r));
  console.log("Retained trial: " + dataDir);
}
