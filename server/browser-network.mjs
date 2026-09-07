import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";

export function browserURL(value, forbiddenPorts = []) {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Enter an HTTP or HTTPS URL.");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Only HTTP(S) URLs without embedded credentials are supported.",
    );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    local &&
    forbiddenPorts.includes(
      Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    )
  )
    throw new Error(
      "Fleet's internal services cannot be opened in the project browser.",
    );
  return url;
}

export function publicAddress(address) {
  if (net.isIP(address) === 6)
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2001:(?:db8|0):/i.test(address) &&
      !/^2002:/i.test(address)
    );
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}

// Public domains are unrestricted; only the chosen local preview is permitted.
// DNS is resolved and pinned before connecting; public names cannot rebind to LAN/loopback.
export async function browserDestination(
  value,
  localOrigins,
  forbiddenPorts,
  resolveHost = lookup,
) {
  const url = browserURL(value, forbiddenPorts);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let address, family;
  if (["localhost", "127.0.0.1", "::1"].includes(host)) {
    if (!localOrigins.includes(url.origin))
      throw new Error("Only the selected local preview is accessible.");
    address = host === "::1" ? "::1" : "127.0.0.1";
    family = host === "::1" ? 6 : 4;
  } else {
    const records = await resolveHost(host, { all: true });
    if (!records.length || records.some((r) => !publicAddress(r.address)))
      throw new Error("Private and reserved network addresses are blocked.");
    ({ address, family } = records[0]);
  }
  return {
    url,
    address,
    family,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

export async function createBrowserProxy(localOrigins, forbiddenPorts) {
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    // CONNECT/Upgrade hand raw sockets to us before async policy checks finish.
    // Remote resets must close that connection, never crash the Fleet daemon.
    s.on("error", () => s.destroy());
    s.on("close", () => sockets.delete(s));
    return s;
  };
  const proxy = http.createServer(async (req, res) => {
    try {
      const d = await browserDestination(req.url, localOrigins, forbiddenPorts);
      if (d.url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS.");
      const headers = { ...req.headers, host: d.url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const out = http.request(
        {
          hostname: d.address,
          family: d.family,
          port: d.port,
          path: d.url.pathname + d.url.search,
          method: req.method,
          headers,
          agent: false,
          timeout: 15000,
        },
        (upstream) => {
          res.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(res);
        },
      );
      out.on("socket", track);
      out.on("timeout", () => out.destroy());
      out.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("aborted", () => out.destroy());
      req.pipe(out);
    } catch {
      res.writeHead(403).end("Blocked by Fleet browser network policy.");
    }
  });
  proxy.on("connection", track);
  proxy.on("connect", async (req, client, head) => {
    try {
      const d = await browserDestination(
        "https://" + req.url,
        localOrigins,
        forbiddenPorts,
      );
      if (client.destroyed) return;
      const remote = track(
        net.connect({ host: d.address, port: d.port, family: d.family }),
      );
      remote.setTimeout(30000, () => remote.destroy());
      remote.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      client.on("close", () => remote.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  // WebSockets use the same public-network and selected-preview policy.
  proxy.on("upgrade", async (req, client, head) => {
    try {
      const d = await browserDestination(
        req.url.replace(/^ws:/, "http:"),
        localOrigins,
        forbiddenPorts,
      );
      if (client.destroyed) return;
      const remote = track(
        net.connect({ host: d.address, port: d.port, family: d.family }),
      );
      remote.once("connect", () => {
        const headers = { ...req.headers, host: d.url.host };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        remote.write(
          `${req.method} ${d.url.pathname + d.url.search} HTTP/1.1\r\n${Object.entries(
            headers,
          )
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")}\r\n\r\n`,
        );
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      client.on("close", () => remote.destroy());
    } catch {
      client.destroy();
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    port: proxy.address().port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}
