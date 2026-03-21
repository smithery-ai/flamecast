import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  CreateAgentBody,
  FilePreview,
  FileSystemSnapshot,
  Session,
  SessionSummary,
} from "../../src/shared/session.js";
import { FlamecastNotFoundError } from "../../src/flamecast/errors.js";
import { createServerApp } from "../../src/server/app.js";
import type { FlamecastApi } from "../../src/flamecast/api.js";

const sampleAgent: Agent = {
  id: "agent-1",
  agentName: "Codex ACP",
  spawn: { command: "npx", args: ["@zed-industries/codex-acp"] },
  runtime: { provider: "local" },
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  latestSessionId: "session-1",
  sessionCount: 1,
};

const sampleSession: Session = {
  id: "session-1",
  agentId: sampleAgent.id,
  agentName: sampleAgent.agentName,
  spawn: sampleAgent.spawn,
  cwd: "/tmp/flamecast",
  startedAt: "2026-03-21T00:00:00.000Z",
  lastUpdatedAt: "2026-03-21T00:00:00.000Z",
  logs: [],
  pendingPermission: null,
  fileSystem: null,
};

const sampleSessionSummary: SessionSummary = {
  id: sampleSession.id,
  agentId: sampleSession.agentId,
  agentName: sampleSession.agentName,
  cwd: sampleSession.cwd,
  startedAt: sampleSession.startedAt,
  lastUpdatedAt: sampleSession.lastUpdatedAt,
  pendingPermission: sampleSession.pendingPermission,
};

const sampleFileSystem: FileSystemSnapshot = {
  root: "/tmp/flamecast",
  entries: [{ path: "src", type: "directory" }],
  truncated: false,
  maxEntries: 1,
};

const sampleFilePreview: FilePreview = {
  path: "src/app.tsx",
  content: "console.log('preview');\n",
  truncated: false,
  maxChars: 20_000,
};

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    createAgent: vi.fn(async (_body: CreateAgentBody) => sampleAgent),
    getAgent: vi.fn(async (_id: string) => sampleAgent),
    getFilePreview: vi.fn(
      async (_agentId: string, _sessionId: string, _path: string) => sampleFilePreview,
    ),
    getSessionFileSystem: vi.fn(
      async (_agentId: string, _sessionId: string, _opts?: { showAllFiles?: boolean }) =>
        sampleFileSystem,
    ),
    getSession: vi.fn(
      async (
        _agentId: string,
        _sessionId: string,
        _opts?: { includeFileSystem?: boolean; showAllFiles?: boolean },
      ) => sampleSession,
    ),
    handleAcp: vi.fn(async (_agentId: string, _request: Request) => new Response("ok")),
    listAgents: vi.fn(async () => [sampleAgent]),
    listSessions: vi.fn(async () => [sampleSessionSummary]),
    terminateAgent: vi.fn(async () => undefined),
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
  it("lists read-only sessions for the sidebar", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);
    const response = await app.request("/api/sessions");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleSessionSummary]);
    expect(flamecast.listSessions).toHaveBeenCalledTimes(1);
  });

  it("lists agents", async () => {
    const app = createServerApp(createFlamecastStub());
    const response = await app.request("/api/agents");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual([sampleAgent]);
  });

  it("creates agents", async () => {
    const app = createServerApp(createFlamecastStub());
    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spawn: { command: "node", args: ["agent.js"] },
        runtime: { provider: "local" },
        name: "Custom agent",
      } satisfies CreateAgentBody),
    });

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual(sampleAgent);
  });

  it("rejects invalid agent payloads", async () => {
    const app = createServerApp(createFlamecastStub());
    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "missing" }),
    });

    expect(response.status).toBe(400);
  });

  it("returns agent creation errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createServerApp(
      createFlamecastStub({
        createAgent: vi.fn(async () => {
          throw new Error("failed to start agent");
        }),
      }),
    );

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spawn: { command: "node", args: ["agent.js"] },
      } satisfies CreateAgentBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "failed to start agent" });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("stringifies non-Error agent creation failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createServerApp(
      createFlamecastStub({
        createAgent: vi.fn(async () => {
          throw { code: "bad_start" };
        }),
      }),
    );

    const response = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spawn: { command: "node", args: ["agent.js"] },
      } satisfies CreateAgentBody),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "[object Object]" });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("fetches an agent", async () => {
    const app = createServerApp(createFlamecastStub());
    const response = await app.request(`/api/agents/${sampleAgent.id}`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleAgent);
  });

  it("returns 404 for unknown agents", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getAgent: vi.fn(async () => {
          throw new FlamecastNotFoundError('Agent "missing" not found');
        }),
      }),
    );
    const response = await app.request("/api/agents/missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Agent not found" });
  });

  it("returns 500 for unexpected agent lookup errors", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getAgent: vi.fn(async () => {
          throw new Error("agent lookup failed");
        }),
      }),
    );
    const response = await app.request(`/api/agents/${sampleAgent.id}`);

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "agent lookup failed" });
  });

  it("fetches nested session details and forwards filesystem query flags", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}?includeFileSystem=true&showAllFiles=true`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleSession);
    expect(flamecast.getSession).toHaveBeenCalledWith(sampleAgent.id, sampleSession.id, {
      includeFileSystem: true,
      showAllFiles: true,
    });
  });

  it("fetches a nested filesystem snapshot separately", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/filesystem?showAllFiles=true`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFileSystem);
    expect(flamecast.getSessionFileSystem).toHaveBeenCalledWith(sampleAgent.id, sampleSession.id, {
      showAllFiles: true,
    });
  });

  it("returns 404 for unknown nested sessions", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getSession: vi.fn(async () => {
          throw new FlamecastNotFoundError('Session "missing" not found');
        }),
      }),
    );
    const response = await app.request(`/api/agents/${sampleAgent.id}/sessions/missing`);

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Session not found" });
  });

  it("returns 500 for unexpected nested session lookup errors", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getSession: vi.fn(async () => {
          throw new Error("session lookup failed");
        }),
      }),
    );
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}`,
    );

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "session lookup failed" });
  });

  it("returns 404 for unknown nested filesystem snapshots", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getSessionFileSystem: vi.fn(async () => {
          throw new FlamecastNotFoundError('Session "missing" not found');
        }),
      }),
    );
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/filesystem`,
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Session not found" });
  });

  it("returns 500 for unexpected nested filesystem snapshot errors", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getSessionFileSystem: vi.fn(async () => {
          throw new Error("filesystem failed");
        }),
      }),
    );
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/filesystem`,
    );

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "filesystem failed" });
  });

  it("fetches nested file previews", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(sampleFilePreview);
    expect(flamecast.getFilePreview).toHaveBeenCalledWith(
      sampleAgent.id,
      sampleSession.id,
      sampleFilePreview.path,
    );
  });

  it("returns 400 for missing file preview paths", async () => {
    const app = createServerApp(createFlamecastStub());
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/file`,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Missing path" });
  });

  it("returns 400 for file preview errors", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getFilePreview: vi.fn(async () => {
          throw new Error("preview failed");
        }),
      }),
    );
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "preview failed" });
  });

  it("falls back to the default file preview error string for non-Error failures", async () => {
    const app = createServerApp(
      createFlamecastStub({
        getFilePreview: vi.fn(async () => {
          throw Symbol.for("preview");
        }),
      }),
    );
    const response = await app.request(
      `/api/agents/${sampleAgent.id}/sessions/${sampleSession.id}/file?path=${encodeURIComponent(sampleFilePreview.path)}`,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Unknown error" });
  });

  it("proxies per-agent ACP requests", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);
    const response = await app.request(`/api/agents/${sampleAgent.id}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(flamecast.handleAcp).toHaveBeenCalledOnce();
  });

  it("returns 404 when the ACP agent is missing", async () => {
    const app = createServerApp(
      createFlamecastStub({
        handleAcp: vi.fn(async () => {
          throw new FlamecastNotFoundError('Agent "missing" not found');
        }),
      }),
    );
    const response = await app.request("/api/agents/missing/acp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Agent not found" });
  });

  it("returns 500 for ACP transport failures", async () => {
    const app = createServerApp(
      createFlamecastStub({
        handleAcp: vi.fn(async () => {
          throw new Error("transport exploded");
        }),
      }),
    );
    const response = await app.request(`/api/agents/${sampleAgent.id}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "transport exploded" });
  });

  it("terminates agents", async () => {
    const flamecast = createFlamecastStub();
    const app = createServerApp(flamecast);
    const response = await app.request(`/api/agents/${sampleAgent.id}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(flamecast.terminateAgent).toHaveBeenCalledWith(sampleAgent.id);
  });

  it("returns 404 when terminating an unknown agent", async () => {
    const app = createServerApp(
      createFlamecastStub({
        terminateAgent: vi.fn(async () => {
          throw new FlamecastNotFoundError('Agent "missing" not found');
        }),
      }),
    );
    const response = await app.request("/api/agents/missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Agent not found" });
  });

  it("returns 500 when termination fails unexpectedly", async () => {
    const app = createServerApp(
      createFlamecastStub({
        terminateAgent: vi.fn(async () => {
          throw new Error("terminate failed");
        }),
      }),
    );
    const response = await app.request(`/api/agents/${sampleAgent.id}`, { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: "terminate failed" });
  });

  it("does not expose /api/health anymore", async () => {
    const app = createServerApp(createFlamecastStub());
    const response = await app.request("/api/health");

    expect(response.status).toBe(404);
  });
});
