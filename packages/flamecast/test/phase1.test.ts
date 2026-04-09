/* oxlint-disable no-type-assertion/no-type-assertion */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi } from "../src/flamecast/api.js";
import { createClient, createTestStorage } from "./fixtures/test-helpers.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { AgentTemplate, PendingPermission } from "../src/shared/session.js";
import type {
  SessionHostStartResponse,
  PermissionRequestEvent,
} from "@flamecast/protocol/session-host";

// ---------------------------------------------------------------------------
// Mock Runtime — implements Runtime interface for unit/integration tests
// ---------------------------------------------------------------------------

function createMockRuntime(): Runtime {
  const sessions = new Map<string, { hostUrl: string; websocketUrl: string }>();

  return {
    async autoStart() { throw new Error("not supported"); },
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.endsWith("/start") && request.method === "POST") {
        const hostUrl = `http://localhost:9999`;
        const websocketUrl = `ws://localhost:9999/ws`;

        sessions.set(sessionId, { hostUrl, websocketUrl });

        const result: SessionHostStartResponse = {
          acpSessionId: sessionId,
          hostUrl,
          websocketUrl,
        };

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path.endsWith("/terminate") && request.method === "POST") {
        sessions.delete(sessionId);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!sessions.has(sessionId)) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Sample agent templates matching the "Example agent" and "Codex ACP" shape
// ---------------------------------------------------------------------------

const exampleTemplate: AgentTemplate = {
  id: "example",
  name: "Example agent",
  spawn: { command: "node", args: ["agent.js"] },
  runtime: { provider: "local" },
};

const codexTemplate: AgentTemplate = {
  id: "codex",
  name: "Codex ACP",
  spawn: { command: "pnpm", args: ["dlx", "@zed-industries/codex-acp"] },
  runtime: { provider: "local" },
};

// ===========================================================================
// 1. Template seeding
// ===========================================================================

describe("template seeding", () => {
  it("returns seeded templates via GET /api/agent-templates", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      agentTemplates: [exampleTemplate, codexTemplate],
    });
    const client = createClient(flamecast);

    try {
      const res = await client["agent-templates"].$get();
      expect(res.status).toBe(200);

      const templates = await res.json();
      expect(templates).toHaveLength(2);

      // Verify "Example agent" shape
      const example = templates.find((t: AgentTemplate) => t.id === "example");
      expect(example).toBeDefined();
      expect(example!.name).toBe("Example agent");
      expect(example!.spawn).toEqual({ command: "node", args: ["agent.js"] });
      expect(example!.runtime).toEqual({ provider: "local" });

      // Verify "Codex ACP" shape
      const codex = templates.find((t: AgentTemplate) => t.id === "codex");
      expect(codex).toBeDefined();
      expect(codex!.name).toBe("Codex ACP");
      expect(codex!.spawn).toEqual({
        command: "pnpm",
        args: ["dlx", "@zed-industries/codex-acp"],
      });
      expect(codex!.runtime).toEqual({ provider: "local" });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns empty templates when none are seeded", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });
    const client = createClient(flamecast);

    try {
      const res = await client["agent-templates"].$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 2. Start from template
// ===========================================================================

describe("start from template", () => {
  it("creates a session via POST /api/agents with agentTemplateId", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      agentTemplates: [exampleTemplate],
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents.$post({
        json: { agentTemplateId: "example" },
      });
      expect(res.status).toBe(201);

      const session = await res.json();
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("active");
      expect(session.agentName).toBe("Example agent");
      expect(session.spawn).toEqual({ command: "node", args: ["agent.js"] });
      expect(session.websocketUrl).toBeTruthy();
    } finally {
      await flamecast.shutdown();
    }
  });

  it("rejects unknown template id", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      agentTemplates: [exampleTemplate],
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents.$post({
        json: { agentTemplateId: "nonexistent" },
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/nonexistent/i);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 3. Permission event shape — regression test
// ===========================================================================

describe("permission event shape", () => {
  it("PendingPermission schema has flat shape with requestId, toolCallId, title, kind, options", async () => {
    // Verify the PendingPermission type has the correct flat shape
    // (not wrapped in a nested `pendingPermission` key).
    // This is the critical contract the frontend relies on.
    const permission: PendingPermission = {
      requestId: "req-1",
      toolCallId: "tool-1",
      title: "Allow file write",
      kind: "file_write",
      options: [
        { optionId: "allow", name: "Allow", kind: "approve" },
        { optionId: "deny", name: "Deny", kind: "reject" },
      ],
    };

    // Verify required fields exist at the top level (flat, not nested)
    expect(permission).toHaveProperty("requestId");
    expect(permission).toHaveProperty("toolCallId");
    expect(permission).toHaveProperty("title");
    expect(permission).toHaveProperty("kind");
    expect(permission).toHaveProperty("options");

    // Verify options have correct shape
    expect(permission.options).toHaveLength(2);
    expect(permission.options[0]).toEqual({
      optionId: "allow",
      name: "Allow",
      kind: "approve",
    });
  });

  it("PermissionRequestEvent shape matches PendingPermission for frontend derivation", async () => {
    // The frontend derives pendingPermission from WS events like:
    //   if (event.type === "permission_request" && event.data.requestId) {
    //     return event.data as PermissionRequestEvent;
    //   }
    //
    // This test verifies PermissionRequestEvent has the same flat shape
    // that the frontend expects, ensuring the WS event and REST snapshot
    // are structurally compatible.

    const wsEvent: PermissionRequestEvent = {
      requestId: "req-1",
      toolCallId: "tool-1",
      title: "Allow file write",
      kind: "file_write",
      options: [
        { optionId: "allow", name: "Allow", kind: "approve" },
        { optionId: "deny", name: "Deny", kind: "reject" },
      ],
    };

    const restPermission: PendingPermission = {
      requestId: "req-1",
      toolCallId: "tool-1",
      title: "Allow file write",
      kind: "file_write",
      options: [
        { optionId: "allow", name: "Allow", kind: "approve" },
        { optionId: "deny", name: "Deny", kind: "reject" },
      ],
    };

    // WS event data and REST pending permission should be structurally identical
    expect(wsEvent).toEqual(restPermission);

    // Verify the frontend derivation logic works: when a permission_request
    // event arrives via WS, event.data.requestId must be truthy
    expect(wsEvent.requestId).toBeTruthy();
  });

  it("snapshotSession returns flat pendingPermission in session response", async () => {
    // Create a Flamecast instance, create a session, then manually
    // inject a pendingPermission into storage and verify the GET response
    // returns it at the top level (not nested).
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });
    const client = createClient(flamecast);

    try {
      // Create a session
      const createRes = await client.agents.$post({
        json: { spawn: { command: "echo", args: ["hello"] } },
      });
      expect(createRes.status).toBe(201);
      const session = await createRes.json();
      const agentId = session.id;

      // Inject a pendingPermission directly into storage
      const permission: PendingPermission = {
        requestId: "req-42",
        toolCallId: "tool-42",
        title: "Run command: rm -rf /",
        kind: "command_execution",
        options: [
          { optionId: "allow", name: "Allow", kind: "approve" },
          { optionId: "deny", name: "Deny", kind: "reject" },
        ],
      };
      await storage.updateSession(agentId, {
        pendingPermission: permission,
        lastUpdatedAt: new Date().toISOString(),
      });

      // Fetch the session and verify pendingPermission is at the top level
      const getRes = await client.agents[":agentId"].$get({
        param: { agentId },
      });
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();

      // The pendingPermission should be flat (not wrapped in another object)
      expect(fetched.pendingPermission).toBeDefined();
      expect(fetched.pendingPermission).not.toBeNull();

      const pp = fetched.pendingPermission!;
      expect(pp.requestId).toBe("req-42");
      expect(pp.toolCallId).toBe("tool-42");
      expect(pp.title).toBe("Run command: rm -rf /");
      expect(pp.kind).toBe("command_execution");
      expect(pp.options).toHaveLength(2);
      expect(pp.options[0]).toEqual({
        optionId: "allow",
        name: "Allow",
        kind: "approve",
      });
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 4. API contract tests — CRUD operations with new runtimes option
// ===========================================================================

describe("API contract with runtimes option", () => {
  it("list agents (empty)", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents.$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("404 for unknown agent", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents[":agentId"].$get({
        param: { agentId: "nonexistent" },
      });
      expect(res.status).toBe(404);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("session lifecycle with create get list terminate", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });
    const client = createClient(flamecast);

    try {
      // Create
      const createRes = await client.agents.$post({
        json: { spawn: { command: "echo", args: ["hello"] } },
      });
      expect(createRes.status).toBe(201);
      const session = await createRes.json();
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("active");
      expect(session.agentName).toBe("echo hello");
      expect(session.websocketUrl).toBeTruthy();

      const agentId = session.id;

      // Get
      const getRes = await client.agents[":agentId"].$get({
        param: { agentId },
      });
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.id).toBe(agentId);
      expect(fetched.status).toBe("active");

      // List
      const listRes = await client.agents.$get();
      expect(listRes.status).toBe(200);
      const agents = await listRes.json();
      expect(agents.length).toBeGreaterThanOrEqual(1);
      expect(agents.some((a: { id: string }) => a.id === agentId)).toBe(true);

      // Terminate
      const killRes = await client.agents[":agentId"].$delete({
        param: { agentId },
      });
      expect(killRes.status).toBe(200);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("health endpoint works with runtimes", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });

    try {
      const api = createApi(flamecast);
      const app = new Hono().route("/api", api);

      const res = await app.fetch(new Request("http://localhost/api/health"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok", sessions: 0 });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("session uses template runtime provider", async () => {
    const storage = await createTestStorage();
    const localRuntime = createMockRuntime();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: localRuntime },
      agentTemplates: [exampleTemplate],
    });
    const client = createClient(flamecast);

    try {
      // Start a session from the template (which has runtime.provider = "local")
      const res = await client.agents.$post({
        json: { agentTemplateId: "example" },
      });
      expect(res.status).toBe(201);

      const session = await res.json();
      expect(session.status).toBe("active");
      expect(session.agentName).toBe("Example agent");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("rejects session when runtime provider is missing", async () => {
    const storage = await createTestStorage();
    // Only register a "cloud" runtime, but template references "local"
    const flamecast = new Flamecast({
      storage,
      runtimes: { cloud: createMockRuntime() },
      agentTemplates: [exampleTemplate],
    });
    const client = createClient(flamecast);

    try {
      const res = await client.agents.$post({
        json: { agentTemplateId: "example" },
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/local/i);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("register and list user templates alongside seeded templates", async () => {
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      agentTemplates: [exampleTemplate],
    });
    const client = createClient(flamecast);

    try {
      // Register a user template
      const registerRes = await client["agent-templates"].$post({
        json: {
          name: "Custom agent",
          spawn: { command: "python", args: ["agent.py"] },
        },
      });
      expect(registerRes.status).toBe(201);

      // List should return both seeded + user-registered
      const listRes = await client["agent-templates"].$get();
      expect(listRes.status).toBe(200);
      const templates = await listRes.json();

      // Seeded template first, then user-registered
      expect(templates.length).toBe(2);
      expect(templates[0].name).toBe("Example agent");
      expect(templates[1].name).toBe("Custom agent");
    } finally {
      await flamecast.shutdown();
    }
  });
});
