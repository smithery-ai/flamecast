import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentTemplate,
  CreateSessionBody,
  FilePreview,
  FileSystemSnapshot,
  RegisterAgentTemplateBody,
  Session,
} from "../../src/shared/session.js";
import { createServerApp } from "../../src/flamecast/app.js";
import type { FlamecastApi } from "../../src/flamecast/api.js";
import { EventBus } from "../../src/flamecast/events/bus.js";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";
import type { QueuedMessage } from "@flamecast/protocol/storage";

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
const sampleFilePreview: FilePreview = {
  path: "src/index.ts",
  content: "console.log('hello');",
  truncated: false,
  maxChars: 100_000,
};
const sampleFileSystem: FileSystemSnapshot = {
  root: "/tmp/flamecast",
  path: "/tmp/flamecast",
  entries: [
    { path: "src", type: "directory" },
    { path: "src/index.ts", type: "file" },
  ],
  truncated: false,
  maxEntries: 10_000,
};
const sampleRuntimeInstance: RuntimeInstance = {
  name: "default",
  typeName: "default",
  status: "running",
  websocketUrl: "ws://localhost:9999",
};
const sampleRuntimeInfo: RuntimeInfo = {
  typeName: "default",
  onlyOne: true,
  instances: [sampleRuntimeInstance],
};
const sampleQueuedMessage: QueuedMessage = {
  id: 1,
  sessionId: sampleSession.id,
  text: "hello",
  runtime: "default",
  agent: sampleAgentTemplate.name,
  agentTemplateId: sampleAgentTemplate.id,
  directory: null,
  status: "pending",
  createdAt: "2026-03-21T00:00:00.000Z",
  sentAt: null,
};

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
    listRuntimes: vi.fn(async () => []),
    listAgentTemplates: vi.fn(async () => [sampleAgentTemplate]),
    registerAgentTemplate: vi.fn(async (body: RegisterAgentTemplateBody) => ({
      id: "registered-template",
      name: body.name,
      spawn: body.spawn,
      runtime: body.runtime ?? { provider: "default" },
    })),
    handleSessionEvent: vi.fn(async () => ({ ok: true })),
    startRuntime: vi.fn(async () => ({ name: "default", typeName: "default", status: "running" })),
    stopRuntime: vi.fn(async () => undefined),
    pauseRuntime: vi.fn(async () => undefined),
    fetchRuntimeFilePreview: vi.fn(async () => sampleFilePreview),
    fetchRuntimeFileSystem: vi.fn(async () => sampleFileSystem),
    fetchSessionFilePreview: vi.fn(async () => sampleFilePreview),
    fetchSessionFileSystem: vi.fn(async () => sampleFileSystem),
    promptSession: vi.fn(async () => ({ stopReason: "end_turn" })),
    enqueueMessage: vi.fn(async () => sampleQueuedMessage),
    listQueuedMessages: vi.fn(async () => [sampleQueuedMessage]),
    markMessageSent: vi.fn(async () => undefined),
    removeMessage: vi.fn(async () => undefined),
    clearMessageQueue: vi.fn(async () => undefined),
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

  it("preserves the runtime websocket port for relative agent requests", async () => {
    const session = {
      ...sampleSession,
      websocketUrl: "ws://localhost:9999/sessions/session-1",
    } satisfies Session;
    const flamecast = createFlamecastStub({
      createSession: vi.fn(async () => session),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentTemplateId: sampleAgentTemplate.id,
      } satisfies CreateSessionBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(session);
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

  it("returns a session file preview through Flamecast", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/files?path=src%2Findex.ts`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFilePreview);
    expect(flamecast.fetchSessionFilePreview).toHaveBeenCalledWith(sampleAgentId, "src/index.ts");
  });

  it("requires a path for session file previews", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/files`);

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Missing ?path= parameter" });
  });

  it("passes through upstream file preview status codes", async () => {
    const flamecast = createFlamecastStub({
      fetchSessionFilePreview: vi.fn(async () => {
        throw Object.assign(new Error("Cannot read: agent.ts"), { status: 404 });
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/files?path=agent.ts`);

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Cannot read: agent.ts" });
  });

  it("returns a session filesystem snapshot through Flamecast", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/agents/${sampleAgentId}/fs/snapshot`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFileSystem);
    expect(flamecast.fetchSessionFileSystem).toHaveBeenCalledWith(sampleAgentId, {
      showAllFiles: false,
      path: undefined,
    });
  });

  it("passes showAllFiles through the session filesystem route", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(
      `/api/agents/${sampleAgentId}/fs/snapshot?showAllFiles=true`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFileSystem);
    expect(flamecast.fetchSessionFileSystem).toHaveBeenCalledWith(sampleAgentId, {
      showAllFiles: true,
      path: undefined,
    });
  });

  it("returns a runtime file preview through Flamecast", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/runtimes/default/files?path=src%2Findex.ts`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFilePreview);
    expect(flamecast.fetchRuntimeFilePreview).toHaveBeenCalledWith("default", "src/index.ts");
  });

  it("rewrites runtime websocket URLs for the client origin", async () => {
    const flamecast = createFlamecastStub({
      listRuntimes: vi.fn(async () => [sampleRuntimeInfo]),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("https://app.flamecast.dev/api/runtimes");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([
      {
        ...sampleRuntimeInfo,
        instances: [{ ...sampleRuntimeInstance, websocketUrl: "wss://app.flamecast.dev:9999/" }],
      },
    ]);
  });

  it("rewrites runtime websocket URLs when starting a runtime", async () => {
    const flamecast = createFlamecastStub({
      startRuntime: vi.fn(async () => sampleRuntimeInstance),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("https://app.flamecast.dev/api/runtimes/default/start", {
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({
      ...sampleRuntimeInstance,
      websocketUrl: "wss://app.flamecast.dev:9999/",
    });
  });

  it("returns a runtime filesystem snapshot through Flamecast", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/runtimes/default/fs/snapshot?showAllFiles=true`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFileSystem);
    expect(flamecast.fetchRuntimeFileSystem).toHaveBeenCalledWith("default", {
      showAllFiles: true,
      path: undefined,
    });
  });

  it("preserves runtime proxy 409 errors", async () => {
    class RuntimeNotRunningError extends Error {
      readonly status = 409;
    }

    const flamecast = createFlamecastStub({
      fetchRuntimeFileSystem: vi.fn(async () => {
        throw new RuntimeNotRunningError('Runtime instance "default" is not running');
      }),
    });
    const app = createServerApp(flamecast);

    const response = await app.request(`/api/runtimes/default/fs/snapshot`);

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: 'Runtime instance "default" is not running',
    });
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

  it("lists queued messages", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/message-queue");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleQueuedMessage]);
  });

  it("auto-selects a runtime/template and creates a session for queued messages", async () => {
    const queuedMessage = { ...sampleQueuedMessage, runtime: "agentjs", agent: "Agent.js" };
    const flamecast = createFlamecastStub({
      listRuntimes: vi.fn(async () => [
        { typeName: "agentjs", onlyOne: true, instances: [] },
        sampleRuntimeInfo,
      ]),
      listAgentTemplates: vi.fn(async () => [
        {
          ...sampleAgentTemplate,
          id: "agentjs-template",
          name: "Agent.js",
          runtime: { provider: "agentjs" },
        },
        sampleAgentTemplate,
      ]),
      createSession: vi.fn(async () => sampleSession),
      enqueueMessage: vi.fn(async () => queuedMessage),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("https://app.flamecast.dev/api/message-queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", directory: "/tmp/flamecast" }),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(queuedMessage);
    expect(flamecast.createSession).toHaveBeenCalledWith(
      {
        agentTemplateId: "agentjs-template",
        cwd: "/tmp/flamecast",
      },
      { callbackUrl: "https://app.flamecast.dev/api" },
    );
    expect(flamecast.enqueueMessage).toHaveBeenCalledWith({
      sessionId: sampleSession.id,
      text: "hello",
      runtime: "agentjs",
      agent: "Agent.js",
      agentTemplateId: "agentjs-template",
      directory: "/tmp/flamecast",
    });
  });

  it("falls back to the first template when the runtime has no matching agent", async () => {
    const flamecast = createFlamecastStub({
      listRuntimes: vi.fn(async () => [{ typeName: "agentjs", onlyOne: true, instances: [] }]),
      createSession: vi.fn(async () => sampleSession),
    });
    const app = createServerApp(flamecast);

    const response = await app.request("/api/message-queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(response.status).toBe(201);
    expect(flamecast.createSession).toHaveBeenCalledWith(
      {
        agentTemplateId: sampleAgentTemplate.id,
        cwd: undefined,
      },
      { callbackUrl: "http://localhost/api" },
    );
    expect(flamecast.enqueueMessage).toHaveBeenCalledWith({
      sessionId: sampleSession.id,
      text: "hello",
      runtime: "agentjs",
      agent: sampleAgentTemplate.name,
      agentTemplateId: sampleAgentTemplate.id,
      directory: null,
    });
  });

  it("uses explicit queued message values without creating a session", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);

    const response = await app.request("/api/message-queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: sampleSession.id,
        text: "hello",
        runtime: "default",
        agent: sampleAgentTemplate.name,
        agentTemplateId: sampleAgentTemplate.id,
        directory: "/tmp/flamecast",
      }),
    });

    expect(response.status).toBe(201);
    expect(flamecast.listRuntimes).not.toHaveBeenCalled();
    expect(flamecast.listAgentTemplates).not.toHaveBeenCalled();
    expect(flamecast.createSession).not.toHaveBeenCalled();
    expect(flamecast.enqueueMessage).toHaveBeenCalledWith({
      sessionId: sampleSession.id,
      text: "hello",
      runtime: "default",
      agent: sampleAgentTemplate.name,
      agentTemplateId: sampleAgentTemplate.id,
      directory: "/tmp/flamecast",
    });
  });
});
