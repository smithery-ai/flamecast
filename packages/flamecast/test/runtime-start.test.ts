import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "@flamecast/protocol/runtime";
import { createTestStorage } from "./fixtures/test-helpers.js";

vi.mock("@flamecast/protocol/verify", () => ({
  signWebhookPayload: () => "signature",
}));

const { Flamecast } = await import("../src/flamecast/index.js");

describe("Flamecast.autoStart", () => {
  it("resolves with the name of the first runtime that auto-starts", async () => {
    const runtime: Runtime = {
      onlyOne: true,
      async autoStart() { /* succeeds */ },
      async fetchSession(): Promise<Response> {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    };

    const flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { local: runtime },
    });

    const name = await flamecast.autoStart();
    expect(name).toBe("local");
  });

  it("skips runtimes that throw and resolves with the one that succeeds", async () => {
    const failing: Runtime = {
      onlyOne: false,
      async autoStart() { throw new Error("not supported"); },
      async fetchSession(): Promise<Response> {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };

    const succeeding: Runtime = {
      onlyOne: true,
      async autoStart() { /* succeeds */ },
      async fetchSession(): Promise<Response> {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };

    const flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { docker: failing, local: succeeding },
    });

    const name = await flamecast.autoStart();
    expect(name).toBe("local");
  });

  it("rejects when all runtimes throw", async () => {
    const runtime: Runtime = {
      onlyOne: true,
      async autoStart() { throw new Error("not supported"); },
      async fetchSession(): Promise<Response> {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };

    const flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { docker: runtime },
    });

    await expect(flamecast.autoStart()).rejects.toThrow();
  });
});

describe("Flamecast.startRuntime", () => {
  it("returns websocket metadata after the runtime starts", async () => {
    let started = false;

    const runtime: Runtime = {
      onlyOne: true,
      async autoStart() { throw new Error("not supported"); },
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

    const flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { local: runtime },
    });
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

    const flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { local: runtime },
    });

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

    const storage = await createTestStorage();
    await storage.saveRuntimeInstance({
      name: "default",
      typeName: "default",
      status: "running",
      websocketUrl: `ws://localhost:${address.port}/`,
    });

    const runtime: Runtime = {
      onlyOne: true,
      async autoStart() { throw new Error("not supported"); },
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
