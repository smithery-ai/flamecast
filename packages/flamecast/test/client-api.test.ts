import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlamecastClient, createFlamecastRpcClient } from "../src/client/api.js";
import type { FlamecastApi } from "../src/flamecast/api.js";
import { createServerApp } from "../src/server/app.js";
import type {
  AgentTemplate,
  CreateSessionBody,
  FilePreview,
  PermissionResponseBody,
  PromptResult,
  RegisterAgentTemplateBody,
  Session,
} from "../src/shared/session.js";

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
  startedAt: "2026-03-23T00:00:00.000Z",
  lastUpdatedAt: "2026-03-23T00:00:00.000Z",
  status: "active",
  logs: [],
  pendingPermission: null,
  promptQueue: null,
  fileSystem: null,
};

const samplePreview: FilePreview = {
  path: "src/app.tsx",
  content: "console.log('preview');\n",
  truncated: false,
  maxChars: 20_000,
};

const samplePromptResult: PromptResult = {
  stopReason: "end_turn",
};

function createFlamecastStub(overrides: Partial<FlamecastApi> = {}): FlamecastApi {
  return {
    terminateSession: vi.fn(async () => undefined),
    createSession: vi.fn(async (_body: CreateSessionBody) => sampleSession),
    getSession: vi.fn(
      async (_id: string, _opts?: { includeFileSystem?: boolean; showAllFiles?: boolean }) =>
        sampleSession,
    ),
    getFilePreview: vi.fn(async (_id: string, _path: string) => samplePreview),
    listSessions: vi.fn(async () => [sampleSession]),
    listAgentTemplates: vi.fn(async () => [sampleAgentTemplate]),
    promptSession: vi.fn(async (_id: string, _text: string) => samplePromptResult),
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

function createFetch(
  flamecast: FlamecastApi,
  onRequest?: (request: Request) => void,
): typeof fetch {
  const app = createServerApp(flamecast);

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    onRequest?.(request);
    return app.fetch(request);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared Flamecast client", () => {
  it("supports the full helper flow against the public API contract", async () => {
    const flamecast = createFlamecastStub();
    const client = createFlamecastClient({
      baseUrl: "https://flamecast.test/api",
      fetch: createFetch(flamecast),
    });

    await expect(client.fetchAgentTemplates()).resolves.toEqual([sampleAgentTemplate]);
    await expect(
      client.registerAgentTemplate({
        name: "Custom agent",
        spawn: { command: "node", args: ["agent.js"] },
      }),
    ).resolves.toEqual({
      id: "registered-template",
      name: "Custom agent",
      spawn: { command: "node", args: ["agent.js"] },
      runtime: { provider: "local" },
    });
    await expect(client.fetchSessions()).resolves.toEqual([sampleSession]);
    await expect(
      client.fetchSession(sampleSession.id, {
        includeFileSystem: true,
        showAllFiles: true,
      }),
    ).resolves.toEqual(sampleSession);
    await expect(client.fetchFilePreview(sampleSession.id, samplePreview.path)).resolves.toEqual(
      samplePreview,
    );
    await expect(
      client.createSession({
        agentTemplateId: sampleAgentTemplate.id,
        cwd: "/tmp/flamecast",
      }),
    ).resolves.toEqual(sampleSession);
    await expect(client.sendPrompt(sampleSession.id, "Hello")).resolves.toEqual(samplePromptResult);
    await expect(
      client.respondToPermission(sampleSession.id, "request-1", { optionId: "allow" }),
    ).resolves.toBeUndefined();
    await expect(client.terminateSession(sampleSession.id)).resolves.toBeUndefined();

    expect(flamecast.getSession).toHaveBeenCalledWith(sampleSession.id, {
      includeFileSystem: true,
      showAllFiles: true,
    });
    expect(flamecast.getFilePreview).toHaveBeenCalledWith(sampleSession.id, samplePreview.path);
    expect(flamecast.createSession).toHaveBeenCalledWith({
      agentTemplateId: sampleAgentTemplate.id,
      cwd: "/tmp/flamecast",
    });
    expect(flamecast.promptSession).toHaveBeenCalledWith(sampleSession.id, "Hello");
    expect(flamecast.respondToPermission).toHaveBeenCalledWith(sampleSession.id, "request-1", {
      optionId: "allow",
    });
    expect(flamecast.terminateSession).toHaveBeenCalledWith(sampleSession.id);
  });

  it("throws stable errors for non-ok helper responses", async () => {
    const flamecast = createFlamecastStub({
      getSession: vi.fn(async () => {
        throw new Error("missing");
      }),
      promptSession: vi.fn(async () => {
        throw new Error("downstream failed");
      }),
    });
    const client = createFlamecastClient({
      baseUrl: "https://flamecast.test/api",
      fetch: createFetch(flamecast),
    });

    await expect(client.fetchSession("missing")).rejects.toThrow("Session not found");
    await expect(client.sendPrompt(sampleSession.id, "Hello")).rejects.toThrow(
      "Failed to send prompt",
    );
  });

  it("builds a raw typed RPC client from a URL base and injected fetch", async () => {
    const requests: string[] = [];
    const rpc = createFlamecastRpcClient({
      baseUrl: new URL("https://flamecast.test/api"),
      fetch: createFetch(createFlamecastStub(), (request) => {
        requests.push(request.url);
      }),
    });

    const response = await rpc.agents.$get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([sampleSession]);
    expect(requests).toEqual(["https://flamecast.test/api/agents"]);
  });

  it("falls back to global fetch when no custom fetch is provided", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createFetch(createFlamecastStub(), (request) => {
        requests.push(request.url);
      }),
    );
    const rpc = createFlamecastRpcClient({
      baseUrl: "https://flamecast.test/api",
    });

    const response = await rpc["agent-templates"].$get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([sampleAgentTemplate]);
    expect(requests).toEqual(["https://flamecast.test/api/agent-templates"]);
  });
});
