/**
 * Tier 1 Integration Test: Session Lifecycle
 *
 * Tests the full happy path through the public API using InProcessSessionHost.
 * No child processes, no Docker, no ports — just the in-process host plus
 * temporary PGLite-backed storage.
 */

/* oxlint-disable no-type-assertion/no-type-assertion */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi } from "../src/flamecast/api.js";
import { InProcessSessionHost } from "./fixtures/in-process-session-host.js";
import { createClient, createTestStorage } from "./fixtures/test-helpers.js";
import type { AgentTemplate } from "../src/shared/session.js";

const exampleTemplate: AgentTemplate = {
  id: "example",
  name: "Example agent",
  spawn: { command: "node", args: ["agent.js"] },
  runtime: { provider: "local" },
};

// ===========================================================================
// Full session lifecycle: create -> get -> list -> terminate -> verify killed
// ===========================================================================

describe("session lifecycle with InProcessSessionHost", () => {
  it("full happy path - create, get, list, terminate, verify status", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      agentTemplates: [exampleTemplate],
    });
    const client = createClient(flamecast);

    try {
      // 1. Create session from template
      const createRes = await client.agents.$post({
        json: { agentTemplateId: "example" },
      });
      expect(createRes.status).toBe(201);

      const session = await createRes.json();
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("active");
      expect(session.agentName).toBe("Example agent");
      expect(session.spawn).toEqual({ command: "node", args: ["agent.js"] });
      expect(session.websocketUrl).toBeTruthy();

      const agentId = session.id;

      // Verify InProcessSessionHost received the session
      expect(runtime.getSessionIds()).toContain(agentId);

      // 2. Get the session
      const getRes = await client.agents[":agentId"].$get({
        param: { agentId },
      });
      expect(getRes.status).toBe(200);

      const fetched = await getRes.json();
      expect(fetched.id).toBe(agentId);
      expect(fetched.status).toBe("active");
      expect(fetched.agentName).toBe("Example agent");
      expect(fetched.spawn).toEqual({ command: "node", args: ["agent.js"] });

      // 3. Verify session shows up in list
      const listRes = await client.agents.$get();
      expect(listRes.status).toBe(200);

      const agents = await listRes.json();
      expect(agents.length).toBeGreaterThanOrEqual(1);
      expect(agents.some((a: { id: string }) => a.id === agentId)).toBe(true);

      // 4. Terminate the session
      const killRes = await client.agents[":agentId"].$delete({
        param: { agentId },
      });
      expect(killRes.status).toBe(200);

      // Verify InProcessSessionHost cleaned up
      expect(runtime.getSessionIds()).not.toContain(agentId);

      // 5. Verify terminated session status via GET
      const afterRes = await client.agents[":agentId"].$get({
        param: { agentId },
      });
      expect(afterRes.status).toBe(200);

      const killed = await afterRes.json();
      expect(killed.id).toBe(agentId);
      expect(killed.status).toBe("killed");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("create session with inline spawn (no template)", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const client = createClient(flamecast);

    try {
      const createRes = await client.agents.$post({
        json: { spawn: { command: "python", args: ["main.py"] } },
      });
      expect(createRes.status).toBe(201);

      const session = await createRes.json();
      expect(session.status).toBe("active");
      expect(session.agentName).toBe("python main.py");
      expect(session.spawn).toEqual({ command: "python", args: ["main.py"] });

      // Verify runtime received it
      expect(runtime.getSessionIds()).toHaveLength(1);
      const internalSession = runtime.getSession(session.id);
      expect(internalSession).toBeDefined();
      expect(internalSession!.command).toBe("python");
      expect(internalSession!.args).toEqual(["main.py"]);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("multiple concurrent sessions are isolated", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const client = createClient(flamecast);

    try {
      // Create two sessions concurrently
      const [res1, res2] = await Promise.all([
        client.agents.$post({ json: { spawn: { command: "echo", args: ["one"] } } }),
        client.agents.$post({ json: { spawn: { command: "echo", args: ["two"] } } }),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      const session1 = await res1.json();
      const session2 = await res2.json();

      expect(session1.id).not.toBe(session2.id);
      expect(runtime.getSessionIds()).toHaveLength(2);

      // Terminate one; the other should remain
      await client.agents[":agentId"].$delete({ param: { agentId: session1.id } });
      expect(runtime.getSessionIds()).toHaveLength(1);
      expect(runtime.getSessionIds()).toContain(session2.id);

      // Second session is still active
      const getRes = await client.agents[":agentId"].$get({
        param: { agentId: session2.id },
      });
      const fetched = await getRes.json();
      expect(fetched.status).toBe("active");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("health endpoint reflects session count", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const api = createApi(flamecast);
      const app = new Hono().route("/api", api);

      // Health with 0 sessions
      const res0 = await app.fetch(new Request("http://localhost/api/health"));
      expect(res0.status).toBe(200);
      expect(await res0.json()).toEqual({ status: "ok", sessions: 0 });

      // Create a session
      await flamecast.createSession({ spawn: { command: "echo", args: ["hi"] } });

      // Health with 1 session
      const res1 = await app.fetch(new Request("http://localhost/api/health"));
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.sessions).toBe(1);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("terminate already-killed session returns 409", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const client = createClient(flamecast);

    try {
      const createRes = await client.agents.$post({
        json: { spawn: { command: "echo", args: ["once"] } },
      });
      const session = await createRes.json();

      // Terminate once
      const kill1 = await client.agents[":agentId"].$delete({
        param: { agentId: session.id },
      });
      expect(kill1.status).toBe(200);

      // Terminate again should fail
      const kill2 = await client.agents[":agentId"].$delete({
        param: { agentId: session.id },
      });
      expect(kill2.status).toBe(409);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("get nonexistent session returns 404", async () => {
    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents[":agentId"].$get({
        param: { agentId: "does-not-exist" },
      });
      expect(res.status).toBe(404);
    } finally {
      await flamecast.shutdown();
    }
  });
});
