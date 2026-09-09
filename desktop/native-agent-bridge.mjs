// Main-process-only command transport. No endpoint or token reaches a website,
// the Fleet renderer, or the model. Long-poll delivery wakes immediately.
export function connectNativeAgent({
  origin,
  projectId,
  nativeId,
  registration = "register",
  execute,
  onStatus = () => {},
  fetchImpl = fetch,
}) {
  const lifetime = new AbortController();
  let token,
    csrf,
    stopped = false;
  const request = async (action, body, signal = lifetime.signal) => {
    const response = await fetchImpl(origin + "/api/native-browser/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fleet-Token": csrf },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error || "Native browser connection failed.");
    return value;
  };
  const loop = async () => {
    while (!stopped) {
      const transport = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, transport.signal]);
      let execution = Promise.resolve();
      try {
        const response = await fetchImpl(origin + "/api/bootstrap", {
          headers: { "X-Fleet-Bootstrap": "1" },
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error("Fleet service is unavailable.");
        csrf = (await response.json()).csrf;
        ({ token } = await request(registration, { projectId, nativeId }));
        if (stopped) break;
        onStatus({ connected: true, error: "" });
        while (!stopped) {
          // Keep the transport alive even when native execution is slow. The
          // broker holds the next command until this one's result is accepted.
          const command = await request("next", { token }, signal);
          if (!command || stopped) continue;
          await execution;
          if (signal.aborted) break;
          execution = (async () => {
            let result, error;
            try {
              result = await execute(command.input);
            } catch (e) {
              error = e.message;
            }
            if (signal.aborted) return;
            await request(
              "result",
              { token, id: command.id, result, error },
              signal,
            );
          })();
          execution.catch((error) => transport.abort(error));
        }
      } catch (e) {
        transport.abort();
        // Never replay or overlap an operation after a transport failure.
        await execution.catch(() => {});
        if (!stopped) {
          onStatus({ connected: false, error: e.message });
          if (token)
            await request("close", { token }, AbortSignal.timeout(1500)).catch(
              () => {},
            );
          token = null;
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              lifetime.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 1000);
            lifetime.signal.addEventListener("abort", done, { once: true });
            if (stopped) done();
          });
        }
      } finally {
        transport.abort();
        await execution.catch(() => {});
      }
    }
  };
  const pending = loop();
  return async () => {
    stopped = true;
    lifetime.abort();
    await pending;
    if (token)
      await request("close", { token }, AbortSignal.timeout(1500)).catch(
        () => {},
      );
  };
}
