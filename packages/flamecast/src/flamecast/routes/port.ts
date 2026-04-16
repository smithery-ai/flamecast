import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";

// --- schemas ---

const PortParam = z.object({
  port: z
    .string()
    .regex(/^[0-9]+$/)
    .openapi({ param: { name: "port", in: "path" }, example: "5173" }),
});

const ErrorResponse = z
  .object({
    error: z.string(),
  })
  .openapi("PortProxyError");

// --- route definitions ---

const proxyWithPath = createRoute({
  method: "get",
  path: "/{port}/*",
  tags: ["Port Forwarding"],
  summary: "Proxy HTTP requests to localhost:<port>",
  description:
    "Forwards any HTTP request to the specified port on localhost. " +
    "Strips the /port/:port prefix before forwarding. " +
    "Response body, status, and headers are passed through from the target service. " +
    "All HTTP methods are supported (GET is shown for documentation purposes).",
  request: { params: PortParam },
  responses: {
    200: { description: "Proxied response from the target service (schema varies)" },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid port number",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Port not in allowed list",
    },
    502: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Target port is not reachable",
    },
  },
});

const proxyWithoutPath = createRoute({
  method: "get",
  path: "/{port}",
  tags: ["Port Forwarding"],
  summary: "Proxy HTTP requests to localhost:<port> (root path)",
  description: "Same as /{port}/* but for requests to the root path of the target service.",
  request: { params: PortParam },
  responses: {
    200: { description: "Proxied response from the target service (schema varies)" },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid port number",
    },
    403: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Port not in allowed list",
    },
    502: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Target port is not reachable",
    },
  },
});

// --- handler ---

function proxyHandler(allowedPorts?: number[]) {
  return async (c: Context) => {
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
}

// --- app ---

export function portRoutes(allowedPorts?: number[]) {
  const app = new OpenAPIHono();

  const handler = proxyHandler(allowedPorts);

  // Register OpenAPI docs (GET only, but handler accepts all methods)
  app.openapi(proxyWithPath, (c) => handler(c));
  app.openapi(proxyWithoutPath, (c) => handler(c));

  // Register all other HTTP methods (not in OpenAPI, but functional)
  for (const method of ["post", "put", "delete", "patch"] as const) {
    app.on(method, "/:port{[0-9]+}/*", handler);
    app.on(method, "/:port{[0-9]+}", handler);
  }

  return app;
}
