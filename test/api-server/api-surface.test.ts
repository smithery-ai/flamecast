import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentProcessInfo,
  ConnectionInfo,
  CreateConnectionBody,
  PermissionResponseBody,
  PromptBody,
  RegisterAgentProcessBody,
} from "../../src/shared/connection.js";
import { createServerApp } from "../../src/server/app.js";
import type { FlamecastApi } from "../../src/flamecast/api.js";

const sampleAgentProcess: AgentProcessInfo = {
  id: "codex",
  label: "Codex ACP",
  spawn: { command: "npx", args: ["@zed-industries/codex-acp"] },
};

const sampleConnection: ConnectionInfo = {
  id: "conn-1",
  agentLabel: "Codex ACP",
  spawn: sampleAgentProcess.spawn,
  sessionId: "session-1",
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  logs: [],
  pendingPermission: null,
};

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    kill: vi.fn(async () => undefined),
    create: vi.fn(async (_body: CreateConnectionBody) => sampleConnection),
    get: vi.fn(async (_id: string) => sampleConnection),
    list: vi.fn(async () => [sampleConnection]),
    listAgentProcesses: vi.fn(() => [sampleAgentProcess]),
    prompt: vi.fn(async (_id: string, _text: string) => ({ stopReason: "end_turn" })),
    registerAgentProcess: vi.fn((body: RegisterAgentProcessBody) => ({
      id: "registered-agent",
      label: body.label,
      spawn: body.spawn,
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
    expect(await readJson(response)).toEqual({ status: "ok", connections: 1 });
    expect(flamecast.list).toHaveBeenCalledTimes(1);
  });

  it("reports degraded status for Error failures", async () => {
    const flamecast = createFlamecastStub({
      list: vi.fn(async () => {
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
      list: vi.fn(async () => {
        throw "boom";
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/health");

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({ status: "degraded", error: "Unknown error" });
  });

  it("lists agent processes", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-processes");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleAgentProcess]);
  });

  it("registers agent processes", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-processes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Custom agent",
        spawn: { command: "node", args: ["agent.js"] },
      } satisfies RegisterAgentProcessBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({
      id: "registered-agent",
      label: "Custom agent",
      spawn: { command: "node", args: ["agent.js"] },
    });
  });

  it("rejects invalid agent process payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agent-processes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spawn: { command: "node", args: [] } }),
    });

    expect(response.status).toBe(400);
  });

  it("lists connections", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleConnection]);
  });

  it("creates connections", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentProcessId: sampleAgentProcess.id,
        cwd: "/tmp/flamecast",
      } satisfies CreateConnectionBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(sampleConnection);
  });

  it("rejects invalid connection payloads", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/flamecast" }),
    });

    expect(response.status).toBe(400);
  });

  it("returns connection creation errors from Error values", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flamecast = createFlamecastStub({
      create: vi.fn(async () => {
        throw new Error("failed to connect");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentProcessId: sampleAgentProcess.id,
      } satisfies CreateConnectionBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "failed to connect" });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns connection creation errors from non-Error values", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flamecast = createFlamecastStub({
      create: vi.fn(async () => {
        throw { message: "opaque failure" };
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentProcessId: sampleAgentProcess.id,
      } satisfies CreateConnectionBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "[object Object]" });
  });

  it("fetches a connection", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/connections/${sampleConnection.id}`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleConnection);
  });

  it("returns 404 for unknown connections", async () => {
    const flamecast = createFlamecastStub({
      get: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections/missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Connection not found" });
  });

  it("sends prompts", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/connections/${sampleConnection.id}/prompt`, {
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

    const response = await app.request(`/api/connections/${sampleConnection.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it("returns prompt errors from Error values", async () => {
    const flamecast = createFlamecastStub({
      prompt: vi.fn(async () => {
        throw new Error("prompt blocked");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/connections/${sampleConnection.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" } satisfies PromptBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "prompt blocked" });
  });

  it("returns prompt errors from non-Error values", async () => {
    const flamecast = createFlamecastStub({
      prompt: vi.fn(async () => {
        throw "prompt failed";
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/connections/${sampleConnection.id}/prompt`, {
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

    const response = await app.request("/api/connections/conn-1/permissions/request-1", {
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

    const response = await app.request("/api/connections/conn-1/permissions/request-1", {
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

    const response = await app.request("/api/connections/conn-1/permissions/request-1", {
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

    const response = await app.request("/api/connections/conn-1/permissions/request-1", {
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

    const response = await app.request("/api/connections/conn-1/permissions/request-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "allow" } satisfies PermissionResponseBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Unknown error" });
  });

  it("kills a connection", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/connections/${sampleConnection.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("returns 404 when killing an unknown connection", async () => {
    const flamecast = createFlamecastStub({
      kill: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/connections/missing", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Connection not found" });
  });
});
