import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { NodeRuntime } from "../src/flamecast/runtimes/node.js";

/** Start a simple HTTP server that records incoming requests and responds. */
function startMockServer(
  handler: (req: { method: string; url: string; body: string }) => { status: number; body: string },
): Promise<{
  url: string;
  server: Server;
  requests: Array<{ method: string; url: string; body: string }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const entry = { method: req.method ?? "GET", url: req.url ?? "/", body };
        requests.push(entry);
        const result = handler(entry);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://localhost:${port}`, server, requests });
    });
  });
}

describe("NodeRuntime", () => {
  let serverToCleanup: Server | null = null;

  afterEach(() => {
    if (serverToCleanup) {
      serverToCleanup.close();
      serverToCleanup = null;
    }
  });

  it("forwards HTTP requests to /sessions/:sessionId/:path", async () => {
    const { url, server, requests } = await startMockServer(() => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);
    const requestBody = JSON.stringify({ command: "echo", args: ["hi"], workspace: "." });

    const response = await runtime.fetchSession(
      "abc",
      new Request("http://host/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }),
    );

    expect(response.status).toBe(200);
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/sessions/abc/start");
    expect(requests[0].body).toBe(requestBody);
  });

  it("propagates error status codes from upstream", async () => {
    const { url, server } = await startMockServer(() => ({
      status: 500,
      body: JSON.stringify({ error: "internal failure" }),
    }));
    serverToCleanup = server;

    const runtime = new NodeRuntime(url);
    const response = await runtime.fetchSession(
      "xyz",
      new Request("http://host/start", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toEqual({ error: "internal failure" });
  });
});
