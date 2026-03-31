/**
 * Integration test: FlamecastSession Virtual Object + WebhookDeliveryService
 *
 * Uses @restatedev/restate-sdk-testcontainers to run a real Restate server
 * in Docker. A mock session-host HTTP server simulates the runtime.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import * as http from "node:http";
import { FlamecastSession, pubsubObject } from "../src/session-object.js";
import { WebhookDeliveryService } from "../src/webhook-service.js";
import type { SessionMeta } from "../src/session-object.js";

// ---------------------------------------------------------------------------
// Mock session-host — minimal HTTP server that responds to /start, /terminate,
// /prompt with the expected shapes.
// ---------------------------------------------------------------------------

interface MockSessionHost {
  server: http.Server;
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
    calls.push({ method: req.method ?? "GET", path: req.url ?? "/", body: parsed });

    const url = req.url ?? "";

    if (url.includes("/start")) {
      const sessionId = url.split("/sessions/")[1]?.split("/")[0] ?? "unknown";
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

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", resolve);
  });

  const port = (server.address() as { port: number }).port;

  return {
    server,
    url: `http://localhost:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("FlamecastSession Virtual Object", () => {
  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let mockHost: MockSessionHost;

  beforeAll(async () => {
    mockHost = await startMockSessionHost();

    env = await RestateTestEnvironment.start({
      services: [FlamecastSession, WebhookDeliveryService, pubsubObject],
    });

    ingress = clients.connect({ url: env.baseUrl() });
  }, 30_000);

  afterAll(async () => {
    await env?.stop();
    await mockHost?.close();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it("start creates session and persists state", async () => {
    const sessionId = "test-session-start";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    const result = await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "echo", args: ["hello"] },
      cwd: "/tmp",
      agentName: "test-agent",
      runtimeName: "local",
    });

    expect(result.sessionId).toBe(sessionId);
    expect(result.hostUrl).toContain("localhost");
    expect(result.websocketUrl).toContain(sessionId);

    // Verify state
    const state = env.stateOf(FlamecastSession, sessionId);
    const meta = await state.get<SessionMeta>("meta");
    expect(meta).toBeDefined();
    expect(meta!.status).toBe("active");
    expect(meta!.agentName).toBe("test-agent");
    expect(meta!.runtimeName).toBe("local");

    // Verify mock was called
    const startCall = mockHost.calls.find((c) => c.path.includes("/start"));
    expect(startCall).toBeDefined();
    expect((startCall!.body as Record<string, unknown>).sessionId).toBe(sessionId);
  });

  it("getStatus returns session meta", async () => {
    const sessionId = "test-session-status";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    // Start first
    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "status-agent",
      runtimeName: "local",
    });

    const meta = await client.getStatus();
    expect(meta).toBeDefined();
    expect(meta!.id).toBe(sessionId);
    expect(meta!.status).toBe("active");
    expect(meta!.agentName).toBe("status-agent");
  });

  it("terminate updates state to killed", async () => {
    const sessionId = "test-session-terminate";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "term-agent",
      runtimeName: "local",
    });

    await client.terminate();

    const meta = await client.getStatus();
    expect(meta).toBeDefined();
    expect(meta!.status).toBe("killed");

    // Verify terminate was called on mock
    const termCall = mockHost.calls.find(
      (c) => c.path.includes("/terminate") && c.path.includes(sessionId),
    );
    expect(termCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  it("turn sends prompt and returns turnId", async () => {
    const sessionId = "test-session-turn";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "turn-agent",
      runtimeName: "local",
    });

    const result = await client.turn({ text: "Hello, agent!" });
    expect(result.turnId).toBeDefined();
    expect(typeof result.turnId).toBe("string");

    // Verify prompt was forwarded
    const promptCall = mockHost.calls.find(
      (c) => c.path.includes("/prompt") && c.path.includes(sessionId),
    );
    expect(promptCall).toBeDefined();
    expect((promptCall!.body as Record<string, unknown>).text).toBe("Hello, agent!");
  });

  it("handleCallback end_turn clears currentTurn", async () => {
    const sessionId = "test-session-endturn";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "endturn-agent",
      runtimeName: "local",
    });

    // Simulate a turn
    await client.turn({ text: "test" });

    // Verify currentTurn is set
    const state = env.stateOf(FlamecastSession, sessionId);
    const turnBefore = await state.get("currentTurn");
    expect(turnBefore).toBeDefined();

    // End the turn
    await client.handleCallback({ type: "end_turn", data: {} });

    const turnAfter = await state.get("currentTurn");
    expect(turnAfter).toBeNull();
  });

  it("handleCallback session_end marks session killed", async () => {
    const sessionId = "test-session-end";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "end-agent",
      runtimeName: "local",
    });

    await client.handleCallback({ type: "session_end", data: {} });

    const meta = await client.getStatus();
    expect(meta!.status).toBe("killed");
  });

  // -------------------------------------------------------------------------
  // Permissions (awakeable-based durable wait)
  // -------------------------------------------------------------------------

  it("permission_request suspends and resolves via ingress awakeable", async () => {
    const sessionId = "test-session-perm";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "perm-agent",
      runtimeName: "local",
    });

    // Fire permission request in background — it will suspend on the awakeable
    const permPromise = client.handleCallback({
      type: "permission_request",
      data: {
        requestId: "req-1",
        toolCallId: "tc-1",
        title: "Allow file write?",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow" },
          { optionId: "deny", name: "Deny", kind: "reject" },
        ],
      },
    });

    // Give Restate a moment to process and suspend
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Read the pending_permission state to get the awakeableId
    const state = env.stateOf(FlamecastSession, sessionId);
    const pending = await state.get<{ awakeableId: string; data: unknown }>(
      "pending_permission",
    );
    expect(pending).toBeDefined();
    expect(pending!.awakeableId).toBeDefined();

    // Resolve the awakeable directly via the ingress — this bypasses the VO's
    // exclusive handler queue, so it doesn't deadlock with the suspended handler.
    await ingress.resolveAwakeable(pending!.awakeableId, {
      optionId: "allow",
    });

    // The original handleCallback should now return with the resolution
    const result = await permPromise;
    expect(result).toEqual({ optionId: "allow" });

    // pending_permission should be cleared
    const clearedPending = await state.get("pending_permission");
    expect(clearedPending).toBeNull();
  }, 20_000);

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  it("getWebhooks returns configured webhooks", async () => {
    const sessionId = "test-session-webhooks";
    const client = ingress.objectClient(FlamecastSession, sessionId);

    const webhooks = [
      {
        id: "wh-1",
        url: "https://example.com/hook",
        secret: "s3cret",
        events: ["session_end" as const],
      },
    ];

    await client.start({
      runtimeUrl: mockHost.url,
      spawn: { command: "test", args: [] },
      cwd: "/tmp",
      agentName: "wh-agent",
      runtimeName: "local",
      webhooks,
    });

    const result = await client.getWebhooks();
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/hook");
  });
});
