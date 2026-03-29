import { describe, it, expect } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { FlamecastStorage } from "../src/flamecast/storage.js";
import { createClient, createTestStorage } from "./fixtures/test-helpers.js";

/** Mock runtime that handles /start and /terminate via the Runtime interface. */
function createMockRuntime(storage: FlamecastStorage): Runtime {
  const sessions = new Set<string>();
  return {
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/start") && request.method === "POST") {
        const id = crypto.randomUUID();
        await storage.createSession({
          id,
          agentName: "mock",
          spawn: { command: "echo", args: [] },
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          status: "active",
          pendingPermission: null,
        });
        sessions.add(id);
        return new Response(
          JSON.stringify({
            acpSessionId: id,
            hostUrl: `http://localhost:9999`,
            websocketUrl: `ws://localhost:9999`,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/terminate") && request.method === "POST") {
        sessions.delete(sessionId);
        return new Response("OK");
      }
      return new Response("OK");
    },
  };
}

describe("api contract", () => {
  it("list agent templates (empty by default)", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    const res = await client["agent-templates"].$get();
    expect(res.status).toBe(200);
    const templates = await res.json();
    expect(templates).toEqual([]);
  });

  it("list agents (empty)", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    const res = await client.agents.$get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404 for unknown agent", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    const res = await client.agents[":agentId"].$get({ param: { agentId: "nonexistent" } });
    expect(res.status).toBe(404);
  });

  it("session lifecycle with create get list terminate", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    const createRes = await client.agents.$post({
      json: {
        spawn: { command: "echo", args: ["hello"] },
      },
    });
    expect(createRes.status).toBe(201);
    const session = await createRes.json();
    expect(session.id).toBeTruthy();

    const agentId = session.id;

    const getRes = await client.agents[":agentId"].$get({ param: { agentId } });
    expect(getRes.status).toBe(200);

    const listRes = await client.agents.$get();
    expect(listRes.status).toBe(200);
    const agents = await listRes.json();
    expect(agents.length).toBeGreaterThanOrEqual(1);

    const killRes = await client.agents[":agentId"].$delete({ param: { agentId } });
    expect(killRes.status).toBe(200);
  });
});
