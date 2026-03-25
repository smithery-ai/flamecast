import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { Flamecast } from "../src/flamecast/index.js";
import type { Runtime } from "../src/flamecast/runtime.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { FlamecastStorage } from "../src/flamecast/storage.js";
import { createApi, type AppType } from "../src/flamecast/api.js";

type AlchemyTestFactory = (meta: ImportMeta, opts: { prefix: string }) => typeof describe;

function isAlchemyTestFactory(value: unknown): value is AlchemyTestFactory {
  return typeof value === "function";
}

const maybeAlchemyTest = Reflect.get(alchemy, "test");

if (!isAlchemyTestFactory(maybeAlchemyTest)) {
  throw new Error("alchemy.test is unavailable");
}

const test = maybeAlchemyTest(import.meta, { prefix: "test" });

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

function createClient(flamecast: Flamecast) {
  const api = createApi(flamecast);
  const app = new Hono().route("/api", api);
  return hc<AppType>("http://localhost/api", {
    fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      return app.fetch(new Request(String(input), init));
    },
  });
}

describe("api contract", () => {
  test("list agent templates (empty by default)", async (scope: unknown) => {
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    try {
      const res = await client["agent-templates"].$get();
      expect(res.status).toBe(200);
      const templates = await res.json();
      expect(templates).toEqual([]);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("list agents (empty)", async (scope: unknown) => {
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents.$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("404 for unknown agent", async (scope: unknown) => {
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents[":agentId"].$get({ param: { agentId: "nonexistent" } });
      expect(res.status).toBe(404);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("session lifecycle with create get list terminate", async (scope: unknown) => {
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime(storage) },
    });
    const client = createClient(flamecast);

    try {
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
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
