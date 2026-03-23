/* oxlint-disable no-type-assertion/no-type-assertion */
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getBuiltinAgentTemplates } from "../src/flamecast/agent-templates.js";
import { Flamecast } from "../src/flamecast/index.js";
import { AcpBridge } from "../src/runtime/acp-bridge.js";
import { LocalRuntimeClient } from "../src/runtime/local.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

type ManagedSessionLike = {
  id: string;
  workspaceRoot: string;
  bridge: any;
  terminate: () => Promise<void>;
  lastFileSystemSnapshot: null;
};

function createMeta(id: string) {
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    status: "active" as const,
    pendingPermission: null,
  };
}

function createMockBridge(opts?: { isInitialized?: boolean }) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    initialize: vi.fn(),
    newSession: vi.fn(),
    prompt: vi.fn(),
    resolvePermission: vi.fn(),
    flush: vi.fn(async () => {}),
    isInitialized: opts?.isInitialized ?? false,
  });
}

function createManagedSession(id: string) {
  return {
    id,
    workspaceRoot: process.cwd(),
    bridge: createMockBridge(),
    terminate: vi.fn(async () => {}),
    lastFileSystemSnapshot: null,
  } satisfies ManagedSessionLike;
}

function attachStorage(flamecast: Flamecast, storage = new MemoryFlamecastStorage()) {
  Reflect.set(flamecast, "storage", storage);
  Reflect.set(flamecast, "readyPromise", Promise.resolve());
  return storage;
}

function getRuntimeClient(flamecast: Flamecast): LocalRuntimeClient {
  return Reflect.get(flamecast, "runtimeClient") as LocalRuntimeClient;
}

function getRuntimeMap(flamecast: Flamecast) {
  return Reflect.get(getRuntimeClient(flamecast), "runtimes") as Map<string, ManagedSessionLike>;
}

function getMethod<Args extends unknown[], Result>(
  target: object,
  name: string,
): (...args: Args) => Result {
  const method = Reflect.get(target, name);
  if (typeof method !== "function") {
    throw new Error(`Expected ${name} to be a function`);
  }
  return method.bind(target) as (...args: Args) => Result;
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

    await flamecast.listen(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flamecast.shutdown();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Flamecast running on http://localhost:"),
    );
  });

  test("registers shutdown handlers while listening and exits cleanly on SIGTERM", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const processOff = vi.spyOn(process, "off").mockImplementation(() => process);
    const processExit = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: string | number | null) => code ?? 0) as typeof process.exit);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const server = await flamecast.listen(0);
    const close = vi.spyOn(server, "close");
    const sigterm = processOn.mock.calls.find(([signal]) => signal === "SIGTERM")?.[1];
    const sigint = processOn.mock.calls.find(([signal]) => signal === "SIGINT")?.[1];

    expect(sigterm).toEqual(expect.any(Function));
    expect(sigint).toEqual(expect.any(Function));

    (sigterm as () => void)();

    const shutdownPromise = Reflect.get(flamecast, "shutdownPromise") as Promise<void> | null;
    await shutdownPromise;
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(processOff).toHaveBeenCalledWith("SIGTERM", sigterm);
    expect(processOff).toHaveBeenCalledWith("SIGINT", sigint);
    expect(log).toHaveBeenCalledWith("\nShutting down...");
    expect(processExit).toHaveBeenCalledWith(0);
  });

  test("avoids duplicate signal registration and rejects listening twice", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const processOff = vi.spyOn(process, "off").mockImplementation(() => process);
    const registerSignalHandlers = getMethod<[], void>(flamecast, "registerSignalHandlers");
    const unregisterSignalHandlers = getMethod<[], void>(flamecast, "unregisterSignalHandlers");

    registerSignalHandlers();
    registerSignalHandlers();

    expect(processOn).toHaveBeenCalledTimes(2);

    unregisterSignalHandlers();

    expect(processOff).toHaveBeenCalledTimes(2);

    await flamecast.listen(0);
    await expect(flamecast.listen(0)).rejects.toThrow("Flamecast is already listening");
    await flamecast.shutdown();
  });

  test("skips signal registration when disabled", () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const registerSignalHandlers = getMethod<[], void>(flamecast, "registerSignalHandlers");

    registerSignalHandlers();

    expect(processOn).not.toHaveBeenCalled();
  });

  test("covers signal shutdown guards and closeServer error paths", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const shutdownFromSignal = getMethod<["SIGINT" | "SIGTERM"], Promise<void>>(
      flamecast,
      "shutdownFromSignal",
    );
    const closeServer = getMethod<[], Promise<void>>(flamecast, "closeServer");
    const processExit = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: string | number | null) => code ?? 0) as typeof process.exit);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    Reflect.set(flamecast, "shutdownPromise", Promise.resolve());
    await shutdownFromSignal("SIGTERM");
    await flamecast.shutdown();

    expect(processExit).not.toHaveBeenCalled();

    Reflect.set(flamecast, "shutdownPromise", null);
    vi.spyOn(flamecast, "shutdown").mockRejectedValueOnce(new Error("shutdown failed"));

    await shutdownFromSignal("SIGINT");

    expect(error).toHaveBeenCalledWith(
      "Failed to shut down Flamecast cleanly after SIGINT.",
      expect.any(Error),
    );
    expect(processExit).toHaveBeenCalledWith(1);

    const directClose = vi.fn();
    Reflect.set(flamecast, "server", { close: directClose });
    await closeServer();
    expect(directClose).toHaveBeenCalledTimes(1);
    expect(Reflect.get(flamecast, "server")).toBeNull();

    const callbackClose = vi.fn((callback: (error?: Error) => void) => callback());
    Reflect.set(flamecast, "server", { close: callbackClose });
    await closeServer();
    expect(callbackClose).toHaveBeenCalledTimes(1);

    Reflect.set(flamecast, "server", {
      close: vi.fn((callback: (error?: Error) => void) => callback(new Error("close failed"))),
    });
    await expect(closeServer()).rejects.toThrow("close failed");

    Reflect.set(flamecast, "server", {
      close: vi.fn(() => {
        throw new Error("close threw");
      }),
    });
    await expect(closeServer()).rejects.toThrow("close threw");
  });

  test("preserves a newer shutdown promise when an older shutdown finishes", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    let releaseTerminate: (() => void) | null = null;

    await storage.createSession(createMeta("session-keep-promise"));
    getRuntimeMap(flamecast).set("session-keep-promise", {
      ...createManagedSession("session-keep-promise"),
      terminate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseTerminate = resolve;
          }),
      ),
    });

    const shutdownPromise = flamecast.shutdown();
    const replacement = Promise.resolve();
    const deadline = Date.now() + 1_000;

    while (!releaseTerminate && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!releaseTerminate) {
      throw new Error("Expected terminate to be pending");
    }

    Reflect.set(flamecast, "shutdownPromise", replacement);
    releaseTerminate();
    await shutdownPromise;

    expect(Reflect.get(flamecast, "shutdownPromise")).toBe(replacement);
  });

  test("covers private helpers: requireStorage, resolveSessionDefinition, resolveRuntime, snapshotSession, registerAgentTemplate, health endpoint, stopRuntime", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    await storage.seedAgentTemplates(getBuiltinAgentTemplates());
    const healthResponse = await flamecast.fetch(new Request("http://localhost/api/health"));
    const rc = getRuntimeClient(flamecast);

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
    const resolveRuntime = getMethod<[string], ManagedSessionLike>(rc, "resolveRuntime");
    const snapshotSession = getMethod<
      [string],
      Promise<Awaited<ReturnType<Flamecast["getSession"]>>>
    >(flamecast, "snapshotSession");
    const stopRuntime = getMethod<
      [
        {
          terminate: () => Promise<void>;
        },
      ],
      Promise<void>
    >(rc, "stopRuntime");

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

    await storage.createSession(createMeta("session-1"));

    const managed = createManagedSession("session-1");
    getRuntimeMap(flamecast).set("session-1", managed);

    expect(resolveRuntime("session-1")).toBe(managed);
    expect(() => resolveRuntime("missing")).toThrow('Session "missing" not found');

    const snapshot = await snapshotSession("session-1");
    expect(snapshot.pendingPermission).toBeNull();
    await expect(snapshotSession("missing")).rejects.toThrow('Session "missing" not found');

    // Test stopRuntime swallows errors
    await stopRuntime({
      terminate: async () => {
        throw new Error("ignored");
      },
    });

    const pendingReadyFlamecast = new Flamecast({ storage: "memory" });
    Reflect.set(pendingReadyFlamecast, "readyPromise", Promise.resolve());
    await getMethod<[], Promise<void>>(pendingReadyFlamecast, "ensureReady")();

    // Terminate and shutdown
    const terminable = createManagedSession("session-3");
    const failing = createManagedSession("session-4");
    await storage.createSession(createMeta("session-3"));
    await storage.createSession(createMeta("session-4"));
    getRuntimeMap(flamecast).set("session-3", terminable);
    getRuntimeMap(flamecast).set("session-4", {
      ...failing,
      terminate: vi.fn(async () => {
        throw new Error("terminate failed");
      }),
    });
    await flamecast.terminateSession("session-3");
    expect((await storage.getSessionMeta("session-3"))?.status).toBe("killed");

    await flamecast.shutdown();
    expect(getRuntimeMap(flamecast).has("session-4")).toBe(true);
  });

  test("killed sessions remain in listSessions with killed status", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);

    const managed = createManagedSession("session-kill-list");
    await storage.createSession(createMeta("session-kill-list"));
    getRuntimeMap(flamecast).set("session-kill-list", managed);

    const beforeList = await flamecast.listSessions();
    expect(beforeList).toHaveLength(1);
    expect(beforeList[0].status).toBe("active");

    await flamecast.terminateSession("session-kill-list");

    const afterList = await flamecast.listSessions();
    expect(afterList).toHaveLength(1);
    expect(afterList[0].status).toBe("killed");
    expect(afterList[0].id).toBe("session-kill-list");
  });

  test("getSession returns killed sessions", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);

    const managed = createManagedSession("session-kill-get");
    await storage.createSession(createMeta("session-kill-get"));
    getRuntimeMap(flamecast).set("session-kill-get", managed);

    await flamecast.terminateSession("session-kill-get");

    const session = await flamecast.getSession("session-kill-get");
    expect(session.status).toBe("killed");
    expect(session.id).toBe("session-kill-get");
  });

  test("terminateSession on an already-killed session throws", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);

    const managed = createManagedSession("session-kill-twice");
    await storage.createSession(createMeta("session-kill-twice"));
    getRuntimeMap(flamecast).set("session-kill-twice", managed);

    await flamecast.terminateSession("session-kill-twice");

    await expect(flamecast.terminateSession("session-kill-twice")).rejects.toThrow(
      "Cannot terminate an already-killed session",
    );
  });

  test("memory backend preserves logs after finalization", async () => {
    const storage = new MemoryFlamecastStorage();

    await storage.createSession(createMeta("session-logs"));
    await storage.appendLog("session-logs", {
      timestamp: "2024-01-01T00:00:00.000Z",
      type: "rpc",
      data: { ok: true },
    });

    await storage.finalizeSession("session-logs", "terminated");

    const logs = await storage.getLogs("session-logs");
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe("rpc");

    const meta = await storage.getSessionMeta("session-logs");
    expect(meta?.status).toBe("killed");
  });

  test("memory backend listAllSessions returns active and killed sessions", async () => {
    const storage = new MemoryFlamecastStorage();

    await storage.createSession({
      ...createMeta("session-a"),
      lastUpdatedAt: "2024-01-01T00:00:01.000Z",
    });
    await storage.createSession({
      ...createMeta("session-b"),
      lastUpdatedAt: "2024-01-01T00:00:02.000Z",
    });
    await storage.finalizeSession("session-a", "terminated");

    const all = await storage.listAllSessions();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe("session-b");
    expect(all[0].status).toBe("active");
    expect(all[1].id).toBe("session-a");
    expect(all[1].status).toBe("killed");
  });

  test("memory backend finalizeSession is a no-op for nonexistent sessions", async () => {
    const storage = new MemoryFlamecastStorage();
    await storage.finalizeSession("nonexistent", "terminated");
    expect(await storage.getSessionMeta("nonexistent")).toBeNull();
  });

  test("memory backend getLogs returns empty array for unknown session", async () => {
    const storage = new MemoryFlamecastStorage();
    expect(await storage.getLogs("nonexistent")).toEqual([]);
  });

  test("terminateSession falls through to resolveRuntime when session is active but not in runtimes", async () => {
    const flamecast = new Flamecast({ storage: "memory" });
    const storage = attachStorage(flamecast);
    await storage.createSession(createMeta("orphaned-active-term"));

    await expect(flamecast.terminateSession("orphaned-active-term")).rejects.toThrow(
      'Session "orphaned-active-term" not found',
    );
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
