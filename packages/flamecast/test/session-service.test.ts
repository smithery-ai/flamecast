import { describe, it, expect } from "vitest";
import { SessionService } from "../src/flamecast/session-service.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { Runtime } from "@flamecast/protocol/runtime";

function createMockRuntime(): Runtime & {
  calls: Array<{ sessionId: string; method: string }>;
} {
  const calls: Array<{ sessionId: string; method: string }> = [];
  return {
    calls,
    async fetchSession(sessionId, request) {
      const url = new URL(request.url);
      calls.push({ sessionId, method: url.pathname });
      // Return a fake start response
      if (url.pathname.endsWith("/start")) {
        return new Response(
          JSON.stringify({
            acpSessionId: "acp-" + sessionId,
            hostUrl: `http://localhost:9999`,
            websocketUrl: `ws://localhost:9999`,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("OK");
    },
  };
}

function defaultStartOpts(provider: string) {
  return {
    agentName: "test-agent",
    spawn: { command: "echo", args: ["hello"] },
    cwd: ".",
    runtime: { provider },
    startedAt: new Date().toISOString(),
  };
}

describe("SessionService", () => {
  it("dispatches to the correct runtime provider", async () => {
    const mockA = createMockRuntime();
    const mockB = createMockRuntime();
    const service = new SessionService({ a: mockA, b: mockB });
    const storage = new MemoryFlamecastStorage();

    await service.startSession(storage, defaultStartOpts("a"));

    expect(mockA.calls.length).toBe(1);
    expect(mockA.calls[0].method).toBe("/start");
    expect(mockB.calls.length).toBe(0);
  });

  it("throws for unknown provider with available list", async () => {
    const mockA = createMockRuntime();
    const mockB = createMockRuntime();
    const service = new SessionService({ a: mockA, b: mockB });
    const storage = new MemoryFlamecastStorage();

    await expect(service.startSession(storage, defaultStartOpts("nonexistent"))).rejects.toThrow(
      /Unknown runtime: "nonexistent"/,
    );

    await expect(service.startSession(storage, defaultStartOpts("nonexistent"))).rejects.toThrow(
      /Available: a, b/,
    );
  });

  it("routes terminate to the correct runtime provider", async () => {
    const mockA = createMockRuntime();
    const mockB = createMockRuntime();
    const service = new SessionService({ a: mockA, b: mockB });
    const storage = new MemoryFlamecastStorage();

    const { sessionId } = await service.startSession(storage, defaultStartOpts("a"));
    mockA.calls.length = 0; // reset after start

    await service.terminateSession(storage, sessionId);

    expect(mockA.calls.length).toBe(1);
    expect(mockA.calls[0].method).toBe("/terminate");
    expect(mockA.calls[0].sessionId).toBe(sessionId);
    expect(mockB.calls.length).toBe(0);
  });

  it("tracks sessions via hasSession and listSessionIds", async () => {
    const mock = createMockRuntime();
    const service = new SessionService({ local: mock });
    const storage = new MemoryFlamecastStorage();

    const { sessionId } = await service.startSession(storage, defaultStartOpts("local"));

    expect(service.hasSession(sessionId)).toBe(true);
    expect(service.listSessionIds()).toContain(sessionId);

    await service.terminateSession(storage, sessionId);

    expect(service.hasSession(sessionId)).toBe(false);
    expect(service.listSessionIds()).not.toContain(sessionId);
  });
});
