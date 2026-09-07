import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

// This private endpoint belongs to one owned Chrome. It prevents the native
// controller from creating visible tabs/windows or activating Chrome at all.
export async function createBackgroundGate(endpoint, onTarget) {
  const path = `/devtools/browser/${randomUUID()}`;
  const server = http.createServer((req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4000000 });
  const connections = new Set();
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== path || req.headers.origin) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (down) =>
      wss.emit("connection", down),
    );
  });
  wss.on("connection", (down) => {
    const up = new WebSocket(endpoint, { maxPayload: 8000000 });
    connections.add(down);
    connections.add(up);
    const creates = new Set();
    let ready = false;
    const queued = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      connections.delete(down);
      connections.delete(up);
      down.terminate();
      up.terminate();
    };
    down.on("error", close);
    up.on("error", close);
    down.on("close", close);
    up.on("close", close);
    up.on("open", () => {
      ready = true;
      for (const value of queued) up.send(value);
      queued.length = 0;
    });
    down.on("message", (raw) => {
      let value;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        return close();
      }
      if (
        ["Page.bringToFront", "Target.activateTarget"].includes(value.method)
      ) {
        down.send(
          JSON.stringify({
            id: value.id,
            result: {},
            ...(value.sessionId ? { sessionId: value.sessionId } : {}),
          }),
        );
        return;
      }
      if (value.method === "Target.createTarget") {
        value.params = { ...value.params, hidden: true, background: true };
        for (const key of [
          "newWindow",
          "forTab",
          "focus",
          "windowState",
          "left",
          "top",
          "width",
          "height",
        ])
          delete value.params[key];
        creates.add(value.id);
      }
      const data = JSON.stringify(value);
      if (ready) {
        if (up.bufferedAmount > 8000000) return close();
        up.send(data);
      } else if (queued.length < 100) queued.push(data);
      else close();
    });
    up.on("message", async (raw) => {
      let value;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        return close();
      }
      if (creates.delete(value.id) && value.result?.targetId) {
        try {
          await onTarget(value.result.targetId);
        } catch (error) {
          value = {
            id: value.id,
            error: { code: -32000, message: error.message },
          };
        }
      }
      if (down.readyState === WebSocket.OPEN) {
        if (down.bufferedAmount > 8000000) return close();
        down.send(JSON.stringify(value));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}${path}`,
    port: server.address().port,
    async close() {
      for (const connection of connections) connection.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
