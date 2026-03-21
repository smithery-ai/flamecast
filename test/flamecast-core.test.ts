/* eslint-disable no-type-assertion/no-type-assertion */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getBuiltinAgentTemplates } from "../src/flamecast/agent-templates.js";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

type ManagedAgentLike = {
  id: string;
  agentName: string;
  spawn: { command: string; args: string[] };
  runtime: { provider: string };
  transport: {
    input: WritableStream<Uint8Array>;
    output: ReadableStream<Uint8Array>;
    dispose?: () => Promise<void>;
  };
  terminate: () => Promise<void>;
  connection: acp.ClientSideConnection;
  sessionTextChunkLogBuffers: Map<
    string,
    {
      sessionId: string;
      kind: "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";
      messageId: string | null;
      texts: string[];
    }
  >;
};

function createAgentMeta(id: string) {
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    runtime: { provider: "local" as const },
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    latestSessionId: null,
    sessionCount: 0,
  };
}

function createSessionMeta(id: string, agentId: string, cwd: string) {
  return {
    id,
    agentId,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    cwd,
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    pendingPermission: null,
  };
}

function createManagedAgent(id: string): ManagedAgentLike {
  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    runtime: { provider: "local" },
    transport: {
      input: passthrough.writable,
      output: passthrough.readable,
    },
    terminate: vi.fn(async () => {}),
    connection: null as unknown as acp.ClientSideConnection,
    sessionTextChunkLogBuffers: new Map(),
  };
}

function attachStorage(flamecast: Flamecast, storage = new MemoryFlamecastStorage()) {
  Reflect.set(flamecast, "storage", storage);
  Reflect.set(flamecast, "readyPromise", Promise.resolve());
  return storage;
}

function getAgentMap(flamecast: Flamecast) {
  return Reflect.get(flamecast, "agents") as Map<string, ManagedAgentLike>;
}

function getSessionToAgentMap(flamecast: Flamecast) {
  return Reflect.get(flamecast, "sessionToAgentId") as Map<string, string>;
}

function getPermissionResolvers(flamecast: Flamecast) {
  return Reflect.get(flamecast, "permissionResolvers") as Map<
    string,
    {
      sessionId: string;
      request: acp.RequestPermissionRequest;
      resolve: (response: acp.RequestPermissionResponse) => void | Promise<void>;
    }
  >;
}

function getMethod<Args extends unknown[], Result>(
  flamecast: Flamecast,
  name: string,
): (...args: Args) => Result {
  const method = Reflect.get(flamecast, name);
  if (typeof method !== "function") {
    throw new Error(`Expected ${name} to be a function`);
  }
  return method.bind(flamecast) as (...args: Args) => Result;
}

async function waitForPendingPermission(storage: MemoryFlamecastStorage, sessionId: string) {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const pending = (await storage.getSessionMeta(sessionId))?.pendingPermission;
    if (pending) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Expected pending permission request");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("flamecast orchestration internals", () => {
  test("initializes storage lazily and supports listening", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await flamecast.listSessions()).toEqual([]);
    expect(await flamecast.listSessions()).toEqual([]);
    expect(
      (await flamecast.listAgentTemplates()).some((template) => template.id === "example"),
    ).toBe(true);

    const server = await flamecast.listen(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Flamecast running on http://localhost:"),
    );
  });

  test("allows loopback ACP origins in local development and blocks foreign origins", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    const agentId = "agent-origin-test";

    await storage.createAgent(createAgentMeta(agentId));
    getAgentMap(flamecast).set(agentId, createManagedAgent(agentId));

    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      },
    });

    const allowedResponse = await flamecast.handleAcp(
      agentId,
      new Request(`http://127.0.0.1:3001/api/agents/${agentId}/acp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: initializeBody,
      }),
    );

    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers.get("mcp-session-id")).toBeTruthy();

    const blockedResponse = await flamecast.handleAcp(
      agentId,
      new Request(`http://127.0.0.1:3001/api/agents/${agentId}/acp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.com",
        },
        body: initializeBody,
      }),
    );

    expect(blockedResponse.status).toBe(403);
    await expect(blockedResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32003,
        message: "Forbidden origin",
      },
    });
  });

  test("covers current helper methods and downstream client wiring", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    await storage.seedAgentTemplates(getBuiltinAgentTemplates());

    const requireStorage = getMethod<[], MemoryFlamecastStorage>(flamecast, "requireStorage");
    const resolveSessionDefinition = getMethod<
      [
        {
          agentTemplateId?: string;
          name?: string;
          spawn?: { command: string; args?: string[] };
          runtime?: { provider: string };
        },
      ],
      Promise<{
        agentName: string;
        spawn: { command: string; args: string[] };
        runtime: { provider: string };
      }>
    >(flamecast, "resolveSessionDefinition");
    const snapshotSession = getMethod<
      [string, string, { includeFileSystem?: boolean; showAllFiles?: boolean }?],
      Promise<Awaited<ReturnType<Flamecast["getSession"]>>>
    >(flamecast, "snapshotSession");
    const createLogEntry = getMethod<
      [string, Record<string, unknown>],
      { type: string; data: Record<string, unknown> }
    >(flamecast, "createLogEntry");
    const createRpcLog = getMethod<
      [
        string,
        "client_to_agent" | "agent_to_client",
        "request" | "response" | "notification",
        unknown?,
      ],
      { type: string; data: Record<string, unknown> }
    >(flamecast, "createRpcLog");
    const pushLog = getMethod<[string, string, Record<string, unknown>], Promise<void>>(
      flamecast,
      "pushLog",
    );
    const pushRpcLog = getMethod<
      [
        string,
        string,
        "client_to_agent" | "agent_to_client",
        "request" | "response" | "notification",
        unknown?,
      ],
      Promise<void>
    >(flamecast, "pushRpcLog");
    const flushBuffer = getMethod<[ManagedAgentLike, string], Promise<void>>(
      flamecast,
      "flushSessionTextChunkLogBuffer",
    );
    const createPendingPermission = getMethod<
      [acp.RequestPermissionRequest],
      {
        requestId: string;
        toolCallId: string;
        title: string;
        kind?: string;
        options: Array<{ optionId: string; name: string; kind: string }>;
      }
    >(flamecast, "createPendingPermission");
    const takePendingPermissionResolution = getMethod<
      [string, string?],
      Promise<{
        sessionId: string;
        request: acp.RequestPermissionRequest;
        resolve: (response: acp.RequestPermissionResponse) => void | Promise<void>;
      } | null>
    >(flamecast, "takePendingPermissionResolution");
    const stopRuntime = getMethod<
      [
        {
          terminate: () => Promise<void>;
          transport?: { dispose?: () => Promise<void> };
        },
      ],
      Promise<void>
    >(flamecast, "stopRuntime");
    const createDownstreamClient = getMethod<[ManagedAgentLike], acp.Client>(
      flamecast,
      "createDownstreamClient",
    );

    Reflect.set(flamecast, "storage", null);
    expect(() => requireStorage()).toThrow("Flamecast storage is not ready");
    Reflect.set(flamecast, "storage", storage);

    expect(
      await resolveSessionDefinition({ spawn: { command: "node", args: ["agent.js"] } }),
    ).toEqual({
      agentName: "node agent.js",
      spawn: { command: "node", args: ["agent.js"] },
      runtime: { provider: "local" },
    });
    expect(
      await resolveSessionDefinition({
        name: "  Explicit Name  ",
        spawn: { command: "node", args: [] },
      }),
    ).toEqual({
      agentName: "Explicit Name",
      spawn: { command: "node", args: [] },
      runtime: { provider: "local" },
    });
    await expect(resolveSessionDefinition({ agentTemplateId: "missing" })).rejects.toThrow(
      'Unknown agent template "missing"',
    );
    await expect(resolveSessionDefinition({})).rejects.toThrow("Provide agentTemplateId or spawn");
    expect(await resolveSessionDefinition({ agentTemplateId: "example" })).toMatchObject({
      agentName: "Example agent",
      runtime: { provider: "local" },
    });

    const tempDir = await mkdtemp(path.join(process.cwd(), ".flamecast-core-"));
    const agentId = "agent-1";
    const sessionId = "session-1";
    const agentMeta = createAgentMeta(agentId);
    const sessionMeta = createSessionMeta(sessionId, agentId, tempDir);
    const managed = createManagedAgent(agentId);
    const client = createDownstreamClient(() => managed);

    await storage.createAgent(agentMeta);
    await storage.createSession(sessionMeta);
    getAgentMap(flamecast).set(agentId, managed);
    getSessionToAgentMap(flamecast).set(sessionId, agentId);

    try {
      expect(createLogEntry("rpc", { ok: true })).toMatchObject({
        type: "rpc",
        data: { ok: true },
      });
      expect(createRpcLog("method", "client_to_agent", "request")).toMatchObject({
        type: "rpc",
        data: {
          method: "method",
          direction: "client_to_agent",
          phase: "request",
        },
      });

      await pushLog(sessionId, "permission_cancelled", { requestId: "request-1" });
      await pushRpcLog(sessionId, "method", "agent_to_client", "notification", {
        payload: true,
      });
      expect((await storage.getLogs(sessionId)).length).toBeGreaterThan(1);

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "hello " },
        },
      });
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "world" },
        },
      });
      await flushBuffer(managed, sessionId);

      const logs = JSON.stringify(await storage.getLogs(sessionId));
      expect(logs).toContain("hello world");
      expect(logs).toContain('"method":"session/update"');

      const pendingPermission = createPendingPermission({
        sessionId,
        toolCall: {
          toolCallId: "tool-1",
          title: undefined,
          kind: undefined,
          status: "pending",
          rawInput: {},
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      expect(pendingPermission.title).toBe("");
      expect(pendingPermission.kind).toBeUndefined();

      const permissionPromise = client.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: "tool-2",
          title: "Approve",
          kind: "edit",
          status: "pending",
          rawInput: {},
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      const pending = await waitForPendingPermission(storage, sessionId);
      const resolution = await takePendingPermissionResolution(sessionId, pending.requestId);
      expect(resolution).not.toBeNull();
      await Promise.resolve(
        resolution?.resolve({
          outcome: { outcome: "selected", optionId: "allow" },
        }),
      );
      await expect(permissionPromise).resolves.toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
      });
      expect(getPermissionResolvers(flamecast).size).toBe(0);

      const exampleFilePath = path.join(tempDir, "example.txt");
      await writeFile(exampleFilePath, "");
      await expect(
        client.readTextFile!({
          sessionId,
          path: exampleFilePath,
        } as Parameters<acp.Client["readTextFile"]>[0]),
      ).resolves.toEqual({ content: "" });
      await expect(
        client.writeTextFile!({
          sessionId,
          path: exampleFilePath,
          content: "hello",
        } as Parameters<acp.Client["writeTextFile"]>[0]),
      ).resolves.toEqual({});

      expect(
        await client.createTerminal!({
          sessionId,
          command: "echo",
          args: ["hello"],
          cwd: tempDir,
        } as Parameters<acp.Client["createTerminal"]>[0]),
      ).toEqual(expect.objectContaining({ terminalId: expect.stringContaining("stub-") }));
      expect(
        await client.terminalOutput!({
          sessionId,
          terminalId: "terminal-1",
        } as Parameters<acp.Client["terminalOutput"]>[0]),
      ).toEqual({
        output: "",
        truncated: false,
      });
      await expect(
        client.releaseTerminal!({
          sessionId,
          terminalId: "terminal-1",
        } as Parameters<acp.Client["releaseTerminal"]>[0]),
      ).resolves.toEqual({});
      await expect(
        client.waitForTerminalExit!({
          sessionId,
          terminalId: "terminal-1",
        } as Parameters<acp.Client["waitForTerminalExit"]>[0]),
      ).resolves.toEqual({ exitCode: 0 });
      await expect(
        client.killTerminal!({
          sessionId,
          terminalId: "terminal-1",
        } as Parameters<acp.Client["killTerminal"]>[0]),
      ).resolves.toEqual({});

      const snapshot = await snapshotSession(agentId, sessionId);
      snapshot.logs.push({
        timestamp: "2024-01-02T00:00:00.000Z",
        type: "mutated",
        data: {},
      });
      expect((await snapshotSession(agentId, sessionId)).logs).not.toContainEqual(
        expect.objectContaining({ type: "mutated" }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    await stopRuntime({
      terminate: async () => {
        throw new Error("ignored");
      },
    });

    const pendingReadyFlamecast = new Flamecast({ storage: "memory" });
    Reflect.set(pendingReadyFlamecast, "readyPromise", Promise.resolve());
    await getMethod<[], Promise<void>>(pendingReadyFlamecast, "ensureReady")();
  });

  test("fails fast when an agent references an unknown runtime provider", async () => {
    const flamecast = new Flamecast({
      storage: "memory",
      agentTemplates: [
        {
          id: "missing-provider",
          name: "Missing provider",
          spawn: { command: "node", args: [] },
          runtime: { provider: "missing" },
        },
      ],
    });

    await expect(flamecast.createAgent({ agentTemplateId: "missing-provider" })).rejects.toThrow(
      'Unknown runtime provider "missing"',
    );
  });
});
