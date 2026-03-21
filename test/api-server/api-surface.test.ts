import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentTemplate,
  CreateSessionBody,
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
  spawn: { command: "npx", args: ["@zed-industries/codex-acp"] },
  runtime: { provider: "local" },
};

const sampleSession: Session = {
  id: "session-1",
  agentName: "Codex ACP",
  spawn: sampleAgentTemplate.spawn,
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  logs: [],
  pendingPermission: null,
};

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    terminateSession: vi.fn(async () => undefined),
    createSession: vi.fn(async (_body: CreateSessionBody) => sampleSession),
    getSession: vi.fn(async (_id: string) => sampleSession),
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
