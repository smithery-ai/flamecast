/* oxlint-disable no-type-assertion/no-type-assertion */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getBuiltinAgentTemplates } from "../src/flamecast/agent-templates.js";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

type PromptHandler = (params: acp.PromptRequest) => Promise<acp.PromptResponse>;

type ManagedSessionLike = {
  id: string;
  workspaceRoot: string;
  transport: {
    input: WritableStream<Uint8Array>;
    output: ReadableStream<Uint8Array>;
    dispose?: () => Promise<void>;
  };
  terminate: () => Promise<void>;
  runtime: {
    connection: {
      prompt: PromptHandler;
    } | null;
    sessionTextChunkLogBuffer: {
      sessionId: string;
      kind: "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";
      messageId: string | null;
      texts: string[];
    } | null;
  };
};

function createMeta(id: string) {
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    pendingPermission: null,
  };
}

function createManagedSession(id: string, prompt?: PromptHandler) {
  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  return {
    id,
    workspaceRoot: process.cwd(),
    transport: {
      input: passthrough.writable,
      output: passthrough.readable,
    },
    terminate: vi.fn(async () => {}),
    runtime: {
      connection: prompt
        ? {
            prompt,
          }
        : null,
      sessionTextChunkLogBuffer: null,
    },
  } satisfies ManagedSessionLike;
}

function attachStorage(flamecast: Flamecast, storage = new MemoryFlamecastStorage()) {
  Reflect.set(flamecast, "storage", storage);
  Reflect.set(flamecast, "readyPromise", Promise.resolve());
  return storage;
}

function getRuntimeMap(flamecast: Flamecast) {
  return Reflect.get(flamecast, "runtimes") as Map<string, ManagedSessionLike>;
}

function getPermissionResolvers(flamecast: Flamecast) {
  return Reflect.get(flamecast, "permissionResolvers") as Map<
    string,
    (response: acp.RequestPermissionResponse) => void | Promise<void>
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

  test("covers private helpers, client wiring, permission handling, prompt errors, and shutdown", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    await storage.seedAgentTemplates(getBuiltinAgentTemplates());
    const healthResponse = await flamecast.fetch(new Request("http://localhost/api/health"));

    const requireStorage = getMethod<[], MemoryFlamecastStorage>(flamecast, "requireStorage");
    const resolveSessionDefinition = getMethod<
      [
        {
          agentTemplateId?: string;
          name?: string;
          spawn?: { command: string; args?: string[] };
        },
      ],
      {
        agentName: string;
        spawn: { command: string; args: string[] };
        runtime: { provider: string };
      }
    >(flamecast, "resolveSessionDefinition");
    const resolveRuntime = getMethod<[string], ManagedSessionLike>(flamecast, "resolveRuntime");
    const snapshotSession = getMethod<
      [string],
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
    const pushLog = getMethod<
      [ManagedSessionLike, string, Record<string, unknown>],
      Promise<unknown>
    >(flamecast, "pushLog");
    const pushRpcLog = getMethod<
      [
        ManagedSessionLike,
        string,
        "client_to_agent" | "agent_to_client",
        "request" | "response" | "notification",
        unknown?,
      ],
      Promise<void>
    >(flamecast, "pushRpcLog");
    const flushBuffer = getMethod<[ManagedSessionLike], Promise<void>>(
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
    const getPermissionOption = getMethod<
      [
        {
          permission: ReturnType<typeof createPendingPermission>;
          resolve: (response: acp.RequestPermissionResponse) => void | Promise<void>;
        },
        string,
      ],
      { optionId: string; name: string; kind: string }
    >(flamecast, "getPermissionOption");
    const getPermissionLogType = getMethod<[string], string>(flamecast, "getPermissionLogType");
    const stopRuntime = getMethod<
      [
        {
          terminate: () => Promise<void>;
        },
      ],
      Promise<void>
    >(flamecast, "stopRuntime");

    Reflect.set(flamecast, "storage", null);
    expect(() => requireStorage()).toThrow("Flamecast storage is not ready");
    Reflect.set(flamecast, "storage", storage);
    expect(await healthResponse.json()).toEqual({ status: "ok", sessions: 0 });

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
    expect(await resolveSessionDefinition({ spawn: { command: "node" } })).toEqual({
      agentName: "node",
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
    const registeredTemplate = await flamecast.registerAgentTemplate({
      name: "Saved template",
      spawn: { command: "node", args: ["saved.js"] },
    });
    const registeredDockerTemplate = await flamecast.registerAgentTemplate({
      name: "Docker template",
      spawn: { command: "node", args: ["docker.js"] },
      runtime: { provider: "docker", image: "example/image" },
    });
    expect(
      (await flamecast.listAgentTemplates()).some(
        (template) => template.id === registeredTemplate.id,
      ),
    ).toBe(true);
    expect(registeredDockerTemplate.runtime).toEqual({
      provider: "docker",
      image: "example/image",
    });

    await storage.createSession({
      ...createMeta("session-1"),
      pendingPermission: {
        requestId: "request-1",
        toolCallId: "tool-1",
        title: "Approve",
        kind: "edit",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    await storage.appendLog("session-1", {
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "rpc",
      data: { ok: true },
    });

    const managed = createManagedSession("session-1");
    getRuntimeMap(flamecast).set("session-1", managed);

    expect(resolveRuntime("session-1")).toBe(managed);
    expect(() => resolveRuntime("missing")).toThrow('Session "missing" not found');

    const snapshot = await snapshotSession("session-1");
    snapshot.logs.push({
      timestamp: "2024-01-01T00:00:01.000Z",
      type: "mutated",
      data: {},
    });
    snapshot.pendingPermission?.options.push({
      optionId: "mutated",
      name: "Mutated",
      kind: "allow_once",
    });

    const freshSnapshot = await snapshotSession("session-1");
    expect(freshSnapshot.logs).toHaveLength(1);
    expect(freshSnapshot.pendingPermission?.options).toHaveLength(2);
    await expect(snapshotSession("missing")).rejects.toThrow('Session "missing" not found');
    await storage.updateSession("session-1", { pendingPermission: null });

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
    expect(createRpcLog("method", "agent_to_client", "response", { ok: true })).toMatchObject({
      data: {
        payload: { ok: true },
      },
    });

    await pushLog(managed, "permission_cancelled", { requestId: "request-1" });
    await pushRpcLog(managed, "method", "agent_to_client", "notification", {
      payload: true,
    });
    expect((await storage.getLogs("session-1")).length).toBeGreaterThan(2);

    Reflect.set(managed, "pendingLogs", []);
    Reflect.set(managed, "bufferPendingLogs", true);
    const buffered = await pushLog(managed, "buffered_startup_log", { queued: true });
    expect(buffered).toMatchObject({
      type: "buffered_startup_log",
      data: { queued: true },
    });
    expect(Reflect.get(managed, "pendingLogs")).toEqual([buffered]);
    Reflect.set(managed, "pendingLogs", []);
    Reflect.set(managed, "bufferPendingLogs", false);

    const pendingPermission = createPendingPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: undefined,
        kind: undefined,
        status: "pending",
        rawInput: {},
      },
      options: [
        {
          optionId: "allow",
          name: "Allow",
          kind: "allow_once",
        },
      ],
    });
    expect(pendingPermission.title).toBe("");
    expect(pendingPermission.kind).toBeUndefined();
    expect(
      getPermissionOption({ permission: pendingPermission, resolve: () => {} }, "allow"),
    ).toEqual({
      optionId: "allow",
      name: "Allow",
      kind: "allow_once",
    });
    expect(() =>
      getPermissionOption({ permission: pendingPermission, resolve: () => {} }, "missing"),
    ).toThrow('Unknown permission option "missing"');
    expect(getPermissionLogType("allow_once")).toBe("permission_approved");
    expect(getPermissionLogType("reject_once")).toBe("permission_rejected");
    expect(getPermissionLogType("maybe")).toBe("permission_responded");

    const createClient = getMethod<[ManagedSessionLike], acp.Client>(flamecast, "createClient");
    const client = createClient(managed);

    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello " },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "world" },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-2",
        content: { type: "text", text: "thinking" },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "user" },
      },
    });
    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        status: "pending",
      } as unknown as acp.SessionUpdate,
    });

    managed.runtime.sessionTextChunkLogBuffer = {
      sessionId: "session-1",
      kind: "agent_message_chunk",
      messageId: null,
      texts: Object.assign(["a", "b"], {
        join() {
          throw new Error("join failed");
        },
      }),
    } as unknown as ManagedSessionLike["runtime"]["sessionTextChunkLogBuffer"];
    await flushBuffer(managed);
    expect(managed.runtime.sessionTextChunkLogBuffer).toBeNull();

    managed.runtime.sessionTextChunkLogBuffer = {
      sessionId: "session-1",
      kind: "agent_message_chunk",
      messageId: "message-3",
      texts: Object.assign(["c"], {
        join() {
          throw "join failed as string";
        },
      }),
    } as unknown as ManagedSessionLike["runtime"]["sessionTextChunkLogBuffer"];
    await flushBuffer(managed);
    const flushedLogs = JSON.stringify(await storage.getLogs("session-1"));
    expect(flushedLogs).toContain("join failed as string");
    expect(flushedLogs).toContain('"messageId":"message-3"');

    const invalidPermissionPromise = client.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-2",
        title: "Write file",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const requestId = (await waitForPendingPermission(storage, "session-1")).requestId;

    await expect(flamecast.respondToPermission("session-1", requestId, {})).rejects.toThrow(
      "Invalid permission response",
    );
    expect(getPermissionResolvers(flamecast).size).toBe(0);
    void invalidPermissionPromise;

    const unknownOptionPromise = client.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-3",
        title: "Reject file",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
    });
    const unknownOptionRequestId = (await waitForPendingPermission(storage, "session-1")).requestId;
    await expect(
      flamecast.respondToPermission("session-1", unknownOptionRequestId, { optionId: "missing" }),
    ).rejects.toThrow('Unknown permission option "missing"');
    expect(getPermissionResolvers(flamecast).size).toBe(0);
    void unknownOptionPromise;

    const selectionPromise = client.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-4",
        title: "Approve file",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    const selectionRequestId = (await waitForPendingPermission(storage, "session-1")).requestId;

    await flamecast.respondToPermission("session-1", selectionRequestId, { optionId: "allow" });

    expect(await selectionPromise).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const cancelledPromise = client.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-5",
        title: "Delete file",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
    });
    const cancelledRequestId = (await waitForPendingPermission(storage, "session-1")).requestId;
    await flamecast.respondToPermission("session-1", cancelledRequestId, {
      outcome: "cancelled",
    } as Parameters<Flamecast["respondToPermission"]>[2]);
    expect(await cancelledPromise).toEqual({ outcome: { outcome: "cancelled" } });
    expect(getPermissionResolvers(flamecast).size).toBe(0);
    await expect(
      flamecast.respondToPermission("session-1", "missing-request", { optionId: "allow" }),
    ).rejects.toThrow("Permission request not found or already resolved");

    const tempDir = await mkdtemp(path.join(process.cwd(), ".flamecast-core-"));
    const exampleFilePath = path.join(tempDir, "example.txt");
    await writeFile(exampleFilePath, "");

    try {
      expect(
        await client.readTextFile({ path: exampleFilePath } as Parameters<
          acp.Client["readTextFile"]
        >[0]),
      ).toEqual({ content: "" });
      expect(
        await client.writeTextFile({
          path: exampleFilePath,
          content: "hello",
        } as Parameters<acp.Client["writeTextFile"]>[0]),
      ).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    expect(
      await client.createTerminal({
        command: "echo",
        args: ["hello"],
        cwd: process.cwd(),
      } as Parameters<acp.Client["createTerminal"]>[0]),
    ).toEqual(
      expect.objectContaining({
        terminalId: expect.stringContaining("stub-"),
      }),
    );
    expect(
      await client.terminalOutput({
        terminalId: "terminal-1",
      } as Parameters<acp.Client["terminalOutput"]>[0]),
    ).toEqual({
      output: "",
      truncated: false,
    });
    expect(
      await client.releaseTerminal({
        terminalId: "terminal-1",
      } as Parameters<acp.Client["releaseTerminal"]>[0]),
    ).toEqual({});
    expect(
      await client.waitForTerminalExit({
        terminalId: "terminal-1",
      } as Parameters<acp.Client["waitForTerminalExit"]>[0]),
    ).toEqual({
      exitCode: 0,
    });
    expect(
      await client.killTerminal({
        terminalId: "terminal-1",
      } as Parameters<acp.Client["killTerminal"]>[0]),
    ).toEqual({});
    await expect(client.extMethod("x.custom", { ok: true })).rejects.toThrow();
    await expect(client.extNotification("x.notify", { ok: true })).resolves.toBeUndefined();

    const promptingManaged = createManagedSession(
      "session-2",
      vi.fn(async () => {
        throw new Error("prompt failed");
      }),
    );
    await storage.createSession(createMeta("session-2"));
    getRuntimeMap(flamecast).set("session-2", promptingManaged);
    promptingManaged.runtime.sessionTextChunkLogBuffer = {
      sessionId: "session-2",
      kind: "agent_message_chunk",
      messageId: null,
      texts: ["partial"],
    };
    await expect(flamecast.promptSession("session-1", "hello")).rejects.toThrow(
      'Session "session-1" is not initialized',
    );
    await expect(flamecast.promptSession("session-2", "hello")).rejects.toThrow("prompt failed");

    const terminable = createManagedSession(
      "session-3",
      vi.fn(async () => ({ stopReason: "end_turn" })),
    );
    const failing = createManagedSession("session-4");
    await storage.createSession({
      ...createMeta("session-3"),
      pendingPermission: {
        requestId: "request-terminate",
        toolCallId: "tool-terminate",
        title: "Terminate",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    await storage.createSession(createMeta("session-4"));
    getRuntimeMap(flamecast).set("session-3", terminable);
    getRuntimeMap(flamecast).set("session-4", {
      ...failing,
      terminate: vi.fn(async () => {
        throw new Error("terminate failed");
      }),
    });
    getPermissionResolvers(flamecast).set("request-terminate", async () => {});

    await flamecast.terminateSession("session-3");
    expect(await storage.getSessionMeta("session-3")).toBeNull();

    await flamecast.shutdown();
    expect(getRuntimeMap(flamecast).has("session-4")).toBe(true);

    await stopRuntime({
      terminate: async () => {
        throw new Error("ignored");
      },
    });

    const pendingReadyFlamecast = new Flamecast({ storage: "memory" });
    Reflect.set(pendingReadyFlamecast, "readyPromise", Promise.resolve());
    await getMethod<[], Promise<void>>(pendingReadyFlamecast, "ensureReady")();
  });

  test("handles unknown providers and initialization failures while creating sessions", async () => {
    const missingProviderFlamecast = new Flamecast({
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
    await expect(
      missingProviderFlamecast.createSession({ agentTemplateId: "missing-provider" }),
    ).rejects.toThrow('Unknown runtime provider "missing"');
  });
});
