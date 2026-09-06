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
        throw new Error(
          value.error || `Fleet request failed (${response.status}).`,
        );
      if (path === "/state") token = value.csrf;
      return value;
    },
  };
}
