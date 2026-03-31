/**
 * Integration test: RestateSessionService (ISessionService implementation)
 *
 * Verifies that RestateSessionService behaves identically to the in-memory
 * SessionService when exercised through the ISessionService interface.
 *
 * Uses @restatedev/restate-sdk-testcontainers for a real Restate server in
 * Docker, plus a mock session-host HTTP server for runtime simulation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as http from "node:http";
import { FlamecastSession, pubsubObject } from "../src/session-object.js";
import { WebhookDeliveryService } from "../src/webhook-service.js";
import { RestateSessionService } from "../src/restate-session-service.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { FlamecastStorage } from "@flamecast/protocol/storage";

// ---------------------------------------------------------------------------
// Mock session-host — minimal HTTP server that responds to /start, /terminate,
// /prompt with the expected shapes.
// ---------------------------------------------------------------------------

interface MockSessionHost {
  server: http.Server;
  port: number;
  url: string;
  calls: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startMockSessionHost(): Promise<MockSessionHost> {
  const calls: MockSessionHost["calls"] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // not JSON
    }
    calls.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: parsed,
    });

    const url = req.url ?? "";

    if (url.includes("/start")) {
      const sessionId =
        url.split("/sessions/")[1]?.split("/")[0] ?? "unknown";
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hostUrl: `http://localhost:${port}`,
          websocketUrl: `ws://localhost:${port}/ws/${sessionId}`,
        }),
      );
      return;
    }

    if (url.includes("/terminate")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.includes("/prompt")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ queued: true }));
      return;
    }

    // Generic catch-all for proxy tests
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ proxied: true, path: url }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", resolve);
  });

  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    url: `http://localhost:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Mock FlamecastStorage — no-op implementation for the ISessionService contract
// (RestateSessionService ignores storage, delegating to Restate VO state)
// ---------------------------------------------------------------------------

function createMockStorage(): FlamecastStorage {
  return {
    seedAgentTemplates: async () => {},
    listAgentTemplates: async () => [],
    getAgentTemplate: async () => null,
    saveAgentTemplate: async () => {},
    updateAgentTemplate: async () => null,
    createSession: async () => {},
    updateSession: async () => {},
    getSessionMeta: async () => null,
    getStoredSession: async () => null,
    listAllSessions: async () => [],
    listActiveSessionsWithRuntime: async () => [],
    finalizeSession: async () => {},
    saveRuntimeInstance: async () => {},
    listRuntimeInstances: async () => [],
    deleteRuntimeInstance: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("RestateSessionService (ISessionService contract)", () => {
  let env: RestateTestEnvironment;
  let mockHost: MockSessionHost;
  let service: RestateSessionService;
  let storage: FlamecastStorage;

  beforeAll(async () => {
    mockHost = await startMockSessionHost();

    env = await RestateTestEnvironment.start({
      services: [FlamecastSession, WebhookDeliveryService, pubsubObject],
    });

    // Create a mock runtime that provides getWebsocketUrl (used by
    // RestateSessionService to derive the runtime HTTP URL)
    const mockRuntime: Runtime<Record<string, unknown>> = {
      onlyOne: true,
      async fetchSession(_sessionId: string, _request: Request) {
        return new Response("OK");
      },
      getWebsocketUrl(_instanceId: string) {
        return `ws://localhost:${mockHost.port}`;
      },
      async start(_instanceId: string) {},
    };

    service = new RestateSessionService(
      { local: mockRuntime },
      env.baseUrl(),
    );
    storage = createMockStorage();
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    await mockHost?.close();
  });

  // -----------------------------------------------------------------------
  // Helper to start a session with default options
  // -----------------------------------------------------------------------

  function defaultStartOpts() {
    return {
      agentName: "test-agent",
      spawn: { command: "echo", args: ["hello"] },
      cwd: "/tmp",
      runtime: { provider: "local" } as { provider: string } & Record<
        string,
        unknown
      >,
      startedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle tests
  // -----------------------------------------------------------------------

  it("startSession creates a session and returns sessionId", async () => {
    const result = await service.startSession(storage, defaultStartOpts());

    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it("hasSession returns true for active session", async () => {
    const { sessionId } = await service.startSession(
      storage,
      defaultStartOpts(),
    );

    const has = await service.hasSession(sessionId);
    expect(has).toBe(true);
  });

  it("hasSession returns false for unknown session", async () => {
    const has = await service.hasSession("nonexistent-session-id");
    expect(has).toBe(false);
  });

  it("terminateSession removes session", async () => {
    const { sessionId } = await service.startSession(
      storage,
      defaultStartOpts(),
    );
    expect(await service.hasSession(sessionId)).toBe(true);

    await service.terminateSession(storage, sessionId);

    // After termination, hasSession should return false (status is "killed")
    expect(await service.hasSession(sessionId)).toBe(false);
  });

  it("getWebsocketUrl returns URL for active session", async () => {
    const { sessionId } = await service.startSession(
      storage,
      defaultStartOpts(),
    );

    const wsUrl = await service.getWebsocketUrl(sessionId);
    expect(wsUrl).toBeDefined();
    expect(wsUrl).toContain("ws://");
    expect(wsUrl).toContain(sessionId);
  });

  it("getRuntimeName returns provider name", async () => {
    const { sessionId } = await service.startSession(
      storage,
      defaultStartOpts(),
    );

    const name = await service.getRuntimeName(sessionId);
    expect(name).toBe("local");
  });

  it("getWebhooks returns configured webhooks", async () => {
    const webhooks = [
      {
        id: "wh-test",
        url: "https://example.com/hook",
        secret: "s3cret",
        events: ["session_end" as const],
      },
    ];

    const { sessionId } = await service.startSession(storage, {
      ...defaultStartOpts(),
      webhooks,
    });

    const result = await service.getWebhooks(sessionId);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/hook");
    expect(result[0].secret).toBe("s3cret");
  });

  it("getWebhooks returns empty array when no webhooks configured", async () => {
    const { sessionId } = await service.startSession(
      storage,
      defaultStartOpts(),
    );

    const result = await service.getWebhooks(sessionId);
    expect(result).toEqual([]);
  });

  it("listSessionIds returns cached session IDs", async () => {
    // Create a fresh service instance to have a clean cache
    const mockRuntime: Runtime<Record<string, unknown>> = {
      onlyOne: true,
      async fetchSession() {
        return new Response("OK");
      },
      getWebsocketUrl() {
        return `ws://localhost:${mockHost.port}`;
      },
      async start() {},
    };
    const freshService = new RestateSessionService(
      { local: mockRuntime },
      env.baseUrl(),
    );

    // Initially empty
    expect(await freshService.listSessionIds()).toEqual([]);

    // Start a session — should appear in the cache
    const { sessionId: id1 } = await freshService.startSession(
      storage,
      defaultStartOpts(),
    );
    const { sessionId: id2 } = await freshService.startSession(
      storage,
      defaultStartOpts(),
    );

    const ids = await freshService.listSessionIds();
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toHaveLength(2);
  });

  it("proxyRequest forwards to session-host", async () => {
    const { sessionId } = await service.startSession(
      storage,
      defaultStartOpts(),
    );

    const response = await service.proxyRequest(sessionId, "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body).toEqual({ queued: true });

    // Verify the mock host received the call
    const promptCall = mockHost.calls.find(
      (c) => c.path.includes("/prompt") && c.path.includes(sessionId),
    );
    expect(promptCall).toBeDefined();
  });

  it("recoverSession is a no-op (always returns true)", async () => {
    const result = await service.recoverSession("any-session-id", {
      hostUrl: "http://localhost:9999",
      websocketUrl: "ws://localhost:9999",
      runtimeName: "local",
    });

    expect(result).toBe(true);
  });
});
