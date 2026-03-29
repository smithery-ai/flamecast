import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "@flamecast/protocol/runtime";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

vi.mock("@flamecast/protocol/verify", () => ({
  signWebhookPayload: () => "signature",
}));

const { Flamecast } = await import("../src/flamecast/index.js");

describe("Flamecast.startRuntime", () => {
  it("returns websocket metadata after the runtime starts", async () => {
    let started = false;

    const runtime: Runtime = {
      onlyOne: true,
      async fetchSession(): Promise<Response> {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async start(): Promise<void> {
        started = true;
      },
      getWebsocketUrl(): string | undefined {
        return started ? "ws://runtime-host" : undefined;
      },
    };

    const flamecast = new Flamecast({ runtimes: { local: runtime } });
    const instance = await flamecast.startRuntime("local");

    expect(instance).toEqual({
      name: "local",
      typeName: "local",
      status: "running",
      websocketUrl: "ws://runtime-host",
    });
  });

  it("lists implicit runtime instances created by active sessions", async () => {
    const runtime: Runtime = {
      onlyOne: true,
      async fetchSession(sessionId: string, request: Request): Promise<Response> {
        if (new URL(request.url).pathname.endsWith("/start")) {
          return new Response(
            JSON.stringify({
              acpSessionId: sessionId,
              hostUrl: "http://localhost:4321",
              websocketUrl: "ws://localhost:4321",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async getInstanceStatus(): Promise<undefined> {
        return undefined;
      },
    };

    const flamecast = new Flamecast({ runtimes: { local: runtime } });

    await flamecast.createSession({
      spawn: { command: "echo", args: ["hello"] },
    });

    const runtimes = await flamecast.listRuntimes();

    expect(runtimes).toEqual([
      {
        typeName: "local",
        onlyOne: true,
        instances: [
          {
            name: "local",
            typeName: "local",
            status: "running",
            websocketUrl: "ws://localhost:4321",
          },
        ],
      },
    ]);
  });

  it("keeps a persisted runtime running when its websocket health check succeeds", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: [] }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP server address");
    }

    const storage = new MemoryFlamecastStorage();
    await storage.saveRuntimeInstance({
      name: "default",
      typeName: "default",
      status: "running",
      websocketUrl: `ws://localhost:${address.port}/`,
    });

    const runtime: Runtime = {
      onlyOne: true,
      async fetchSession(): Promise<Response> {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async getInstanceStatus(): Promise<undefined> {
        return undefined;
      },
    };

    try {
      const flamecast = new Flamecast({ storage, runtimes: { default: runtime } });
      const runtimes = await flamecast.listRuntimes();

      expect(runtimes).toEqual([
        {
          typeName: "default",
          onlyOne: true,
          instances: [
            {
              name: "default",
              typeName: "default",
              status: "running",
              websocketUrl: `ws://localhost:${address.port}/`,
            },
          ],
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
