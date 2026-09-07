/** One local HTTP contract for the desktop renderer and command line. */
export function createClient({
  base = "/api",
  clientId = crypto.randomUUID(),
  fetchImpl = fetch,
} = {}) {
  let token = "";
  return {
    setToken(value) {
      token = value;
    },
    subscribe(path, onValue, onError = () => {}) {
      const controller = new AbortController();
      (async () => {
        while (!controller.signal.aborted) {
          try {
            const response = await fetchImpl(base + path, {
              headers: { "X-Fleet-Token": token, "X-Fleet-Client": clientId },
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(`Browser stream failed (${response.status}).`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
              while (!controller.signal.aborted) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 4000000)
                  throw new Error("Browser frame exceeds limit.");
                let end;
                while ((end = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, end);
                  buffer = buffer.slice(end + 1);
                  if (line.trim()) onValue(JSON.parse(line));
                }
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
          } catch (error) {
            if (!controller.signal.aborted) onError(error);
          }
          if (!controller.signal.aborted)
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      })();
      return () => controller.abort();
    },
    async request(
      path,
      method = "GET",
      data,
      { requestId = crypto.randomUUID() } = {},
    ) {
      const response = await fetchImpl(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Fleet-Token": token,
          "X-Fleet-Client": clientId,
          ...(!["GET", "HEAD"].includes(method)
            ? { "Idempotency-Key": requestId }
            : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const value = await response.json();
      if (!response.ok)
        throw Object.assign(
          new Error(
            value.error || `Fleet request failed (${response.status}).`,
          ),
          { code: value.code, status: response.status },
        );
      if (path === "/state") token = value.csrf;
      return value;
    },
  };
}
