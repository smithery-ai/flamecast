import { Hono } from "hono";
import type { Context } from "hono";

export function portRoutes(allowedPorts?: number[]) {
  const app = new Hono();

  const handler = async (c: Context) => {
    const portStr = c.req.param("port") ?? "";
    const port = parseInt(portStr, 10);

    if (!portStr || port < 1 || port > 65535) {
      return c.json({ error: `Invalid port: ${portStr}` }, 400);
    }

    if (allowedPorts && !allowedPorts.includes(port)) {
      return c.json({ error: `Port ${port} is not in the allowed list` }, 403);
    }

    // Strip /port/:port prefix to get the forwarded path
    const url = new URL(c.req.url);
    const portPrefix = `/port/${portStr}`;
    const prefixEnd = url.pathname.indexOf(portPrefix) + portPrefix.length;
    const forwardPath = url.pathname.slice(prefixEnd) || "/";
    const targetUrl = `http://127.0.0.1:${port}${forwardPath}${url.search}`;

    // Clone headers, rewrite Host to target
    const headers = new Headers(c.req.raw.headers);
    headers.set("host", `127.0.0.1:${port}`);
    // Remove hop-by-hop headers that shouldn't be forwarded
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("transfer-encoding");

    try {
      const resp = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
        redirect: "manual",
        // @ts-expect-error duplex required for streaming request bodies in Node.js
        duplex: "half",
      });

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    } catch {
      return c.json({ error: `Port ${port} is not reachable` }, 502);
    }
  };

  app.all("/:port{[0-9]+}/*", handler);
  app.all("/:port{[0-9]+}", handler);

  return app;
}
