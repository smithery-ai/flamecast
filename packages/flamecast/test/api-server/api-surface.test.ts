import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentTemplate,
  CreateAgentBody,
  CreateSessionBody,
  FilePreview,
  PermissionResponseBody,
  PromptBody,
  RegisterAgentTemplateBody,
  Session,
} from "../../src/shared/session.js";
import { createServerApp } from "../../src/server/app.js";
import type { FlamecastApi } from "../../src/flamecast/api.js";

const sampleAgentTemplate: AgentTemplate = {
  id: "codex",
  name: "Codex ACP",
  spawn: { command: "pnpm", args: ["dlx", "@zed-industries/codex-acp"] },
  runtime: { provider: "local" },
};

const sampleSession: Session = {
  id: "session-1",
  agentId: "agent-1",
  agentName: "Codex ACP",
  spawn: sampleAgentTemplate.spawn,
  cwd: "/tmp/flamecast",
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  logs: [],
  pendingPermission: null,
  fileSystem: null,
};

const sampleAgent: Agent = {
  id: "agent-1",
  agentName: "Codex ACP",
  spawn: sampleAgentTemplate.spawn,
  runtime: { provider: "local" },
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  latestSessionId: sampleSession.id,
  sessionCount: 1,
};

const sampleFilePreview: FilePreview = {
  path: "src/app.tsx",
  content: "console.log('preview');\n",
  truncated: false,
  maxChars: 20_000,
};

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    terminateSession: vi.fn(async () => undefined),
    terminateAgent: vi.fn(async () => undefined),
    createAgent: vi.fn(async (_body: CreateAgentBody) => sampleAgent),
    createSession: vi.fn(async (_body: CreateSessionBody) => sampleSession),
    getAgent: vi.fn(async (_id: string) => sampleAgent),
    getSession: vi.fn(async () => sampleSession),
    getSessionFileSystem: vi.fn(async () => ({
      root: sampleSession.cwd,
      entries: [],
      truncated: false,
      maxEntries: 0,
    })),
    getFilePreview: vi.fn(async (_id: string, _path: string) => sampleFilePreview),
    handleAcp: vi.fn(
      async (_agentId: string, _request: Request) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    ),
    listAgents: vi.fn(async () => [sampleAgent]),
    listSessions: vi.fn(async () => [sampleSession]),
    listAgentTemplates: vi.fn(async () => [sampleAgentTemplate]),
    promptSession: vi.fn(async (_id: string, _text: string) => ({
      stopReason: "end_turn" as const,
    })),
    registerAgentTemplate: vi.fn(async (body: RegisterAgentTemplateBody) => ({
      id: "registered-template",
      name: body.name,
      spawn: body.spawn,
      runtime: body.runtime ?? { provider: "local" },
    })),
    respondToPermission: vi.fn(
      async (_id: string, _requestId: string, _body: PermissionResponseBody) => undefined,
    ),
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
      runtime: { provider: "local" },
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

  it("lists sessions", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleSession]);
  });

  it("lists agents", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleAgent]);
  });

  it("creates agents", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex ACP",
        spawn: sampleAgentTemplate.spawn,
        initialSessionCwd: sampleSession.cwd,
      } satisfies CreateAgentBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(sampleAgent);
  });

  it("proxies ACP requests through the agent route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgent.id}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    });

    expect(response.status).toBe(202);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(flamecast.handleAcp).toHaveBeenCalledTimes(1);
  });

  it("creates sessions", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions", {
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

  it("rejects invalid session payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/flamecast" }),
    });

    expect(response.status).toBe(400);
  });

  it("returns session creation errors from Error values", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flamecast = createFlamecastStub({
      createSession: vi.fn(async () => {
        throw new Error("failed to start session");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: sampleAgentTemplate.id,
      } satisfies CreateSessionBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "failed to start session" });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns session creation errors from non-Error values", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flamecast = createFlamecastStub({
      createSession: vi.fn(async () => {
        throw { message: "opaque failure" };
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: sampleAgentTemplate.id,
      } satisfies CreateSessionBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "[object Object]" });
  });

  it("fetches a session", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
  });

  it("passes includeFileSystem through the session poll route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}?includeFileSystem=true`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
    expect(flamecast.getSession).toHaveBeenCalledWith(sampleSession.id, {
      includeFileSystem: true,
    });
  });

  it("passes showAllFiles through the session poll route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(
      `/api/sessions/${sampleSession.id}?includeFileSystem=true&showAllFiles=true`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
    expect(flamecast.getSession).toHaveBeenCalledWith(sampleSession.id, {
      includeFileSystem: true,
      showAllFiles: true,
    });
  });

  it("fetches a file preview", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(
      `/api/sessions/${sampleSession.id}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFilePreview);
    expect(flamecast.getFilePreview).toHaveBeenCalledWith(sampleSession.id, sampleFilePreview.path);
  });

  it("returns 400 when file preview path is missing", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}/file`);

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Missing path" });
  });

  it("returns 400 for file preview errors", async () => {
    const flamecast = createFlamecastStub({
      getFilePreview: vi.fn(async () => {
        throw new Error("preview failed");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(
      `/api/sessions/${sampleSession.id}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "preview failed" });
  });

  it("returns 404 for unknown sessions", async () => {
    const flamecast = createFlamecastStub({
      getSession: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Session not found" });
  });

  it("sends prompts", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" } satisfies PromptBody),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ stopReason: "end_turn" });
  });

  it("rejects invalid prompt payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it("returns prompt errors from Error values", async () => {
    const flamecast = createFlamecastStub({
      promptSession: vi.fn(async () => {
        throw new Error("prompt blocked");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" } satisfies PromptBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "prompt blocked" });
  });

  it("returns prompt errors from non-Error values", async () => {
    const flamecast = createFlamecastStub({
      promptSession: vi.fn(async () => {
        throw "prompt failed";
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" } satisfies PromptBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Unknown error" });
  });

  it("responds to permission requests", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/session-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" } satisfies PermissionResponseBody),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("supports cancelled permission responses", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/session-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "cancelled" } satisfies PermissionResponseBody),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("rejects invalid permission payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/session-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: 123 }),
    });

    expect(response.status).toBe(400);
  });

  it("returns permission errors from Error values", async () => {
    const flamecast = createFlamecastStub({
      respondToPermission: vi.fn(async () => {
        throw new Error("permission expired");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/session-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" } satisfies PermissionResponseBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "permission expired" });
  });

  it("returns permission errors from non-Error values", async () => {
    const flamecast = createFlamecastStub({
      respondToPermission: vi.fn(async () => {
        throw "permission failed";
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/session-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" } satisfies PermissionResponseBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Unknown error" });
  });

  it("terminates a session", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/sessions/${sampleSession.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("returns 404 when terminating an unknown session", async () => {
    const flamecast = createFlamecastStub({
      terminateSession: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/sessions/missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Session not found" });
  });
});
