import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentTemplate,
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
  agentName: "Codex ACP",
  spawn: sampleAgentTemplate.spawn,
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  status: "active",
  logs: [],
  pendingPermission: null,
  fileSystem: null,
};

const sampleAgentId = sampleSession.id;

const sampleFilePreview: FilePreview = {
  path: "src/app.tsx",
  content: "console.log('preview');\n",
  truncated: false,
  maxChars: 20_000,
};

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    terminateSession: vi.fn(async () => undefined),
    createSession: vi.fn(async (_body: CreateSessionBody) => sampleSession),
    getSession: vi.fn(
      async (_id: string, _opts?: { includeFileSystem?: boolean; showAllFiles?: boolean }) =>
        sampleSession,
    ),
    getFilePreview: vi.fn(async (_id: string, _path: string) => sampleFilePreview),
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
    subscribe: vi.fn((_sessionId: string, _callback: (event: unknown) => void) => () => {}),
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

  it("returns agent creation errors from Error values", async () => {
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

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "failed to start session" });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns agent creation errors from non-Error values", async () => {
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

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "[object Object]" });
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

  it("fetches a file preview", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(
      `/api/agents/${sampleAgentId}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFilePreview);
    expect(flamecast.getFilePreview).toHaveBeenCalledWith(sampleAgentId, sampleFilePreview.path);
  });

  it("returns 400 when file preview path is missing", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/file`);

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
      `/api/agents/${sampleAgentId}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "preview failed" });
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

  it("sends prompts", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/prompt`, {
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

    const response = await app.request(`/api/agents/${sampleAgentId}/prompt`, {
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

    const response = await app.request(`/api/agents/${sampleAgentId}/prompt`, {
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

    const response = await app.request(`/api/agents/${sampleAgentId}/prompt`, {
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

    const response = await app.request("/api/agents/session-1/permissions/request-1", {
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

    const response = await app.request("/api/agents/session-1/permissions/request-1", {
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

    const response = await app.request("/api/agents/session-1/permissions/request-1", {
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

    const response = await app.request("/api/agents/session-1/permissions/request-1", {
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

    const response = await app.request("/api/agents/session-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" } satisfies PermissionResponseBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Unknown error" });
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
        throw new Error("missing");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents/missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Agent not found" });
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
});

describe("SSE events endpoint", () => {
  it("returns 404 for non-existent session", async () => {
    const flamecast = createFlamecastStub({
      getSession: vi.fn(async () => {
        throw new Error("not found");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/unknown-id/events`);

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Agent not found" });
  });

  it("opens SSE stream for valid session", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/events`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });
});
