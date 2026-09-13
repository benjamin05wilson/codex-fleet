// Each subscription owns its listeners and timer. Ending an HTTP response does
// not synchronously emit request.close, so detach before ending it ourselves.
export function openEventStream(req, res, store, streams) {
  let closed = false;
  let heartbeat;
  const subscription = { close };
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    store.changes.off("change", changeListener);
    store.changes.off("event", eventListener);
    streams.delete(subscription);
  }
  function close() {
    cleanup();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  function send(text) {
    if (closed) return;
    if (res.destroyed || res.writableEnded || res.writableFinished) {
      cleanup();
      return;
    }
    try {
      res.write(text);
    } catch {
      close();
    }
  }
  function changeListener(change) {
    if (change.kind !== "event")
      send(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
  }
  function eventListener(event) {
    send(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
  }
  req.once("close", cleanup);
  res.once("close", cleanup);
  res.once("finish", cleanup);
  // A socket failure may be emitted asynchronously after a successful write.
  res.on("error", cleanup);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  streams.add(subscription);
  store.changes.on("change", changeListener);
  store.changes.on("event", eventListener);
  heartbeat = setInterval(() => send(": keepalive\n\n"), 15000);
  let cursor = Number(
    req.headers["last-event-id"] ||
      new URL(req.url, "http://localhost").searchParams.get("after") ||
      0,
  );
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  try {
    let batch;
    do {
      batch = store.replay(cursor);
      for (const event of batch) {
        if (closed) break;
        eventListener(event);
        cursor = event.seq;
      }
    } while (!closed && batch.length === 500);
  } catch {
    // Headers already describe SSE; end it so the client can reconnect instead
    // of letting the HTTP error handler write JSON to an ended response.
    close();
  }
  return subscription;
}
