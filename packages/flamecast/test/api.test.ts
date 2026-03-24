import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { Flamecast, type RuntimeClient } from "../src/flamecast/index.js";
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

/** Mock runtime client that tracks sessions in memory and persists to storage. */
function createMockRuntimeClient(storage: FlamecastStorage): RuntimeClient {
  const sessions = new Set<string>();
  return {
    async startSession(opts) {
      const sessionId = crypto.randomUUID();
      await storage.createSession({
        id: sessionId,
        agentName: opts.agentName,
        spawn: opts.spawn,
        startedAt: opts.startedAt,
        lastUpdatedAt: new Date().toISOString(),
        status: "active",
        pendingPermission: null,
      });
      sessions.add(sessionId);
      return { sessionId };
    },
    async terminateSession(sessionId) {
      await storage.finalizeSession(sessionId, "terminated");
      sessions.delete(sessionId);
    },
    hasSession(sessionId) {
      return sessions.has(sessionId);
    },
    listSessionIds() {
      return [...sessions];
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
      runtimeClient: createMockRuntimeClient(storage),
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
      runtimeClient: createMockRuntimeClient(storage),
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
      runtimeClient: createMockRuntimeClient(storage),
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
      runtimeClient: createMockRuntimeClient(storage),
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
