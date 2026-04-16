import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Flamecast } from "../../src/flamecast/index.js";

/**
 * Integration tests for the port forwarding proxy endpoint.
 *
 * Spins up a tiny HTTP server on an ephemeral port, then verifies that
 * Flamecast's /port/:port/* proxy correctly forwards requests to it.
 */

function startTargetServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const pathname = req.url?.split("?")[0];
      if (pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (pathname === "/echo") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url, // includes query string
              headers: req.headers,
              body,
            }),
          );
        });
      } else if (pathname === "/redirect") {
        res.writeHead(302, { location: "/health" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      }
    });
  });
}

describe("Port forwarding proxy (integration)", () => {
  let flamecast: Flamecast;
  let target: { server: Server; port: number };

  beforeAll(async () => {
    target = await startTargetServer();
    flamecast = new Flamecast();
  });

  afterAll(() => {
    target.server.close();
  });

  it("proxies GET requests to the target port", async () => {
    const res = await flamecast.app.request(`/port/${target.port}/health`);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });

  it("proxies POST requests with body", async () => {
    const res = await flamecast.app.request(`/port/${target.port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.method).toBe("POST");
    expect(data.url).toBe("/echo");
    expect(JSON.parse(data.body)).toEqual({ hello: "world" });
  });

  it("rewrites Host header to target", async () => {
    const res = await flamecast.app.request(`/port/${target.port}/echo`, {
      method: "POST",
      body: "",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.headers.host).toBe(`127.0.0.1:${target.port}`);
  });

  it("passes through redirect responses without following", async () => {
    const res = await flamecast.app.request(`/port/${target.port}/redirect`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/health");
  });

  it("returns 502 when target port is not listening", async () => {
    const res = await flamecast.app.request("/port/19999/health");

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/not reachable/);
  });

  it("returns 400 for port 0", async () => {
    const res = await flamecast.app.request("/port/0/test");
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-numeric port", async () => {
    const res = await flamecast.app.request("/port/abc/test");
    expect(res.status).toBe(404);
  });

  it("proxies requests without trailing path", async () => {
    // /port/:port with no trailing path should proxy to /
    const res = await flamecast.app.request(`/port/${target.port}`);
    // Target returns 404 for / since we only handle /health and /echo
    expect(res.status).toBe(404);
  });

  it("preserves query parameters", async () => {
    const res = await flamecast.app.request(
      `/port/${target.port}/echo?foo=bar&baz=1`,
      { method: "POST", body: "" },
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe("/echo?foo=bar&baz=1");
  });

  describe("port allowlist", () => {
    let restricted: Flamecast;

    beforeAll(() => {
      restricted = new Flamecast({ allowedPorts: [9999] });
    });

    it("blocks requests to ports not in the allowlist", async () => {
      const res = await restricted.app.request(`/port/${target.port}/health`);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toMatch(/not in the allowed list/);
    });

    it("allows requests to ports in the allowlist", async () => {
      const res = await restricted.app.request("/port/9999/health");
      // Will be 502 since nothing is on 9999, but not 403
      expect(res.status).toBe(502);
    });
  });
});
