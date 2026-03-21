import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { createFlamecast } from "../src/flamecast/config.js";
import { createApi, type AppType } from "../src/flamecast/api.js";
import type { Flamecast } from "../src/flamecast/index.js";

const test = alchemy.test(import.meta, { prefix: "test" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(flamecast: Flamecast) {
  const api = createApi(flamecast);
  const app = new Hono().route("/api", api);
  return hc<AppType>("http://localhost/api", {
    fetch: (input, init) => app.fetch(new Request(input as string, init)),
  });
}

async function pollForPermission(
  client: ReturnType<typeof createClient>,
  connId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.connections[":id"].$get({ param: { id: connId } });
    const conn = await res.json();
    if (conn.pendingPermission) return conn.pendingPermission;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No pending permission after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("api contract", () => {
  test("list agent processes", async (scope) => {
    const flamecast = await createFlamecast({ stateManager: { type: "memory" } });
    const client = createClient(flamecast);

    try {
      const res = await client["agent-processes"].$get();
      expect(res.status).toBe(200);
      const processes = await res.json();
      expect(processes.length).toBeGreaterThan(0);
      expect(processes.find((p: { id: string }) => p.id === "example")).toBeDefined();
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("list connections (empty)", async (scope) => {
    const flamecast = await createFlamecast({ stateManager: { type: "memory" } });
    const client = createClient(flamecast);

    try {
      const res = await client.connections.$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("404 for unknown connection", async (scope) => {
    const flamecast = await createFlamecast({ stateManager: { type: "memory" } });
    const client = createClient(flamecast);

    try {
      const res = await client.connections[":id"].$get({ param: { id: "nonexistent" } });
      expect(res.status).toBe(404);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("full lifecycle through HTTP", async (scope) => {
    const flamecast = await createFlamecast({ stateManager: { type: "memory" } });
    const client = createClient(flamecast);

    try {
      // Create
      const createRes = await client.connections.$post({
        json: { spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] } },
      });
      expect(createRes.status).toBe(201);
      const conn = await createRes.json();
      expect(conn.id).toBeTruthy();
      expect(conn.sessionId).toBeTruthy();

      const connId = conn.id;

      // Get
      const getRes = await client.connections[":id"].$get({ param: { id: connId } });
      expect(getRes.status).toBe(200);

      // Prompt (blocks on permission)
      const promptPromise = client.connections[":id"].prompt.$post({
        param: { id: connId },
        json: { text: "Hello from API contract test!" },
      });

      // Poll + resolve permission
      const pending = await pollForPermission(client, connId, 15_000);
      expect(pending).toBeDefined();

      const allow = pending.options.find((o: { optionId: string }) => o.optionId === "allow");
      if (!allow) throw new Error("No allow option");

      const permRes = await client.connections[":id"].permissions[":requestId"].$post({
        param: { id: connId, requestId: pending.requestId },
        json: { optionId: allow.optionId },
      });
      expect(permRes.status).toBe(200);

      // Prompt completes
      const promptRes = await promptPromise;
      expect(promptRes.status).toBe(200);
      const result = await promptRes.json();
      expect(result.stopReason).toBe("end_turn");

      // Kill
      const killRes = await client.connections[":id"].$delete({ param: { id: connId } });
      expect(killRes.status).toBe(200);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
