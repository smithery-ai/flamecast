import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentTemplate,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  Session,
} from "../../src/shared/session.js";
import { createServerApp } from "../../src/flamecast/app.js";
import type { FlamecastApi } from "../../src/flamecast/api.js";
import { EventBus } from "../../src/flamecast/events/bus.js";

const sampleAgentTemplate: AgentTemplate = {
  id: "codex",
  name: "Codex ACP",
  spawn: { command: "pnpm", args: ["dlx", "@zed-industries/codex-acp"] },
  runtime: { provider: "default" },
};

const sampleSession: Session = {
  id: "session-1",
  agentName: "Codex ACP",
  spawn: sampleAgentTemplate.spawn,
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  status: "active",
  logs: [],
  pendingPermission: null,
  fileSystem: null,
  promptQueue: null,
};

const sampleAgentId = sampleSession.id;

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    eventBus: new EventBus(),
    terminateSession: vi.fn(async () => undefined),
    createSession: vi.fn(async (_body: CreateSessionBody) => sampleSession),
    getSession: vi.fn(
      async (_id: string, _opts?: { includeFileSystem?: boolean; showAllFiles?: boolean }) =>
        sampleSession,
    ),
    listSessions: vi.fn(async () => [sampleSession]),
    listAgentTemplates: vi.fn(async () => [sampleAgentTemplate]),
    registerAgentTemplate: vi.fn(async (body: RegisterAgentTemplateBody) => ({
      id: "registered-template",
      name: body.name,
      spawn: body.spawn,
      runtime: body.runtime ?? { provider: "default" },
    })),
    handleSessionEvent: vi.fn(async () => ({ ok: true })),
    promptSession: vi.fn(async () => ({ stopReason: "end_turn" })),
    proxyQueueRequest: vi.fn(
      async () =>
        new Response(JSON.stringify({ processing: false, paused: false, items: [], size: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
    resolvePermission: vi.fn(async () => ({ ok: true })),
    runtimeNames: ["default"],
    ...overrides,
  };
}

async function readJson(response: Response) {
  return response.json();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API server surface", () => {
  it("reports healthy status", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: "ok", sessions: 1 });
    expect(flamecast.listSessions).toHaveBeenCalledTimes(1);
  });

  it("reports degraded status for Error failures", async () => {
    const flamecast = createFlamecastStub({
      listSessions: vi.fn(async () => {
        throw new Error("database offline");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/health");

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({ status: "degraded", error: "database offline" });
  });

  it("reports degraded status for non-Error failures", async () => {
    const flamecast = createFlamecastStub({
      listSessions: vi.fn(async () => {
        throw "boom";
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/health");

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({ status: "degraded", error: "Unknown error" });
  });

  it("lists agent templates", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-templates");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleAgentTemplate]);
  });

  it("registers agent templates", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom agent",
        spawn: { command: "node", args: ["agent.js"] },
      } satisfies RegisterAgentTemplateBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({
      id: "registered-template",
      name: "Custom agent",
      spawn: { command: "node", args: ["agent.js"] },
      runtime: { provider: "default" },
    });
  });

  it("registers agent templates with explicit runtime config", async () => {
    const flamecast = createFlamecastStub({ runtimeNames: ["default", "agent.js"] });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Agent.js remote",
        spawn: { command: "remote-acp", args: ["agent.js"] },
        runtime: {
          provider: "agent.js",
          baseUrl: "https://flamecast-agent-js.smithery.workers.dev",
        },
      } satisfies RegisterAgentTemplateBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({
      id: "registered-template",
      name: "Agent.js remote",
      spawn: { command: "remote-acp", args: ["agent.js"] },
      runtime: {
        provider: "agent.js",
        baseUrl: "https://flamecast-agent-js.smithery.workers.dev",
      },
    });
  });

  it("rejects invalid agent template payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spawn: { command: "node", args: [] } }),
    });

    expect(response.status).toBe(400);
  });

  it("lists agents via the current session snapshots", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleSession]);
  });

  it("creates agents via the current session runtime flow", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: sampleAgentTemplate.id,
        cwd: "/tmp/flamecast",
      } satisfies CreateSessionBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(sampleSession);
  });

  it("rejects invalid agent payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/flamecast" }),
    });

    expect(response.status).toBe(400);
  });

  it("returns 500 for server-side session creation errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flamecast = createFlamecastStub({
      createSession: vi.fn(async () => {
        throw new Error("failed to start session");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: sampleAgentTemplate.id,
      } satisfies CreateSessionBody),
    });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "failed to start session" });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns 500 for non-Error thrown values", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flamecast = createFlamecastStub({
      createSession: vi.fn(async () => {
        throw { message: "opaque failure" };
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: sampleAgentTemplate.id,
      } satisfies CreateSessionBody),
    });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "Unknown error" });
  });

  it("fetches an agent snapshot", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
  });

  it("treats the trailing slash agent route as the same snapshot", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
  });

  it("passes includeFileSystem through the agent snapshot route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}?includeFileSystem=true`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
    expect(flamecast.getSession).toHaveBeenCalledWith(sampleAgentId, {
      includeFileSystem: true,
    });
  });

  it("passes showAllFiles through the agent snapshot route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(
      `/api/agents/${sampleAgentId}?includeFileSystem=true&showAllFiles=true`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
    expect(flamecast.getSession).toHaveBeenCalledWith(sampleAgentId, {
      includeFileSystem: true,
      showAllFiles: true,
    });
  });

  it("returns 404 for file preview route (removed)", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/file?path=test.txt`);
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown agents", async () => {
    const flamecast = createFlamecastStub({
      getSession: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents/missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Agent not found" });
  });

  it("terminates an agent", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("returns 404 when terminating an unknown agent", async () => {
    const flamecast = createFlamecastStub({
      terminateSession: vi.fn(async () => {
        throw new Error('Session "missing" not found');
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents/missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: 'Session "missing" not found' });
  });

  it("does not expose the old session collection route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions");

    expect(response.status).toBe(404);
    expect(flamecast.listSessions).not.toHaveBeenCalled();
  });

  it("does not expose the old session detail route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}`);

    expect(response.status).toBe(404);
    expect(flamecast.getSession).not.toHaveBeenCalled();
  });

  it("does not expose the removed prompt route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(response.status).toBe(404);
  });

  it("does not expose the removed events route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/events`);

    expect(response.status).toBe(404);
  });

  it("resolves a permission request via REST", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/permissions/request-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" }),
    });

    expect(response.status).toBe(200);
    expect(flamecast.resolvePermission).toHaveBeenCalledWith(sampleAgentId, "request-1", {
      optionId: "allow",
    });
  });

  it("exposes the queue state route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/queue`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      processing: false,
      paused: false,
      items: [],
      size: 0,
    });
  });

  it("exposes the queue cancel route", async () => {
    const flamecast = createFlamecastStub({
      proxyQueueRequest: vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/queue/q1`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
  });
});
