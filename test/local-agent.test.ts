import { describe, it, expect, inject } from "vitest";
import { hc } from "hono/client";
import type { AppType } from "../src/flamecast/index.js";

describe("local agent (ChildProcess stdio transport)", () => {
  it("creates a connection, prompts, resolves permission, and receives agent message", async () => {
    const client = hc<AppType>(inject("apiBaseUrl"));

    const createRes = await client.api.connections.$post({
      json: {
        spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
      },
    });
    expect(createRes.status).toBe(201);
    const conn = await createRes.json();
    expect(conn.id).toBeTruthy();
    expect(conn.sessionId).toBeTruthy();

    const connId = conn.id;

    try {
      const promptPromise = client.api.connections[":id"].prompt.$post({
        param: { id: connId },
        json: { text: "Hello from local test!" },
      });

      const pending = await pollForPermission(client, connId, 15_000);
      expect(pending).toBeDefined();

      const allow = pending.options.find((o: { optionId: string }) => o.optionId === "allow");
      await client.api.connections[":id"].permissions[":requestId"].$post({
        param: { id: connId, requestId: pending.requestId },
        json: { optionId: allow.optionId },
      });

      const promptRes = await promptPromise;
      expect(promptRes.status).toBe(200);
      const result = await promptRes.json();
      expect(result.stopReason).toBe("end_turn");

      const stateRes = await client.api.connections[":id"].$get({ param: { id: connId } });
      const state = await stateRes.json();
      expect(state.logs.length).toBeGreaterThan(0);
    } finally {
      await client.api.connections[":id"].$delete({ param: { id: connId } });
    }
  });
});

async function pollForPermission(
  client: ReturnType<typeof hc<AppType>>,
  connId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.api.connections[":id"].$get({ param: { id: connId } });
    const conn = await res.json();
    if (conn.pendingPermission) return conn.pendingPermission;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No pending permission after ${timeoutMs}ms`);
}
