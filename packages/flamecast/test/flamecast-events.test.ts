/* oxlint-disable no-type-assertion/no-type-assertion */
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { LocalRuntimeClient } from "../src/runtime/local.js";
import { createFileSystemEventStream } from "../src/flamecast/runtime-provider.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { SessionLog } from "../src/shared/session.js";
import { SESSION_EVENT_TYPES } from "../src/shared/session.js";

type MockBridge = EventEmitter & {
  isInitialized: boolean;
  prompt: () => Promise<never>;
  flush: () => Promise<void>;
  resolvePermission: () => void;
  initialize: () => Promise<unknown>;
  newSession: () => Promise<unknown>;
};

function createMockBridge(): MockBridge {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isInitialized: false,
    prompt: async () => {
      throw new Error("not initialized") as never;
    },
    flush: async () => {},
    resolvePermission: () => {},
    initialize: async () => ({}) as unknown,
    newSession: async () => ({}) as unknown,
  }) as MockBridge;
}

type ManagedSessionLike = {
  id: string;
  workspaceRoot: string;
  bridge: MockBridge;
  terminate: () => Promise<void>;
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

function createManagedSession(id: string, workspaceRoot = process.cwd()) {
  return {
    id,
    workspaceRoot,
    pendingLogs: [] as SessionLog[],
    bufferPendingLogs: false,
    bridge: createMockBridge(),
    terminate: vi.fn(async () => {}),
    lastFileSystemSnapshot: null,
    inFlightPromptId: null,
    promptQueue: [],
  };
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session event emission", () => {
  test("subscribe receives events from pushLog", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => {
      received.push(event);
    });

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      rc,
      "pushLog",
    );
    await pushLog(managed, "test_event", { foo: "bar" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("test_event");
    expect(received[0].data).toEqual({ foo: "bar" });
  });

  test("unsubscribe stops event delivery", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    const unsubscribe = flamecast.subscribe("s1", (event) => {
      received.push(event);
    });

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      rc,
      "pushLog",
    );
    await pushLog(managed, "event_1", {});
    unsubscribe();
    await pushLog(managed, "event_2", {});

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("event_1");
  });

  test("multiple subscribers receive the same event", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received1: SessionLog[] = [];
    const received2: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received1.push(event));
    flamecast.subscribe("s1", (event) => received2.push(event));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      rc,
      "pushLog",
    );
    await pushLog(managed, "test_event", {});

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  test("onSessionEvent callback receives events", async () => {
    const onSessionEvent = vi.fn();
    const flamecast = new Flamecast({
      storage: "memory",
      handleSignals: false,
      onSessionEvent,
    });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      rc,
      "pushLog",
    );
    await pushLog(managed, "test_event", { key: "value" });

    expect(onSessionEvent).toHaveBeenCalledOnce();
    expect(onSessionEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "test_event" }),
    );
  });

  test("events are not emitted during bufferPendingLogs phase", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = true;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received.push(event));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      rc,
      "pushLog",
    );
    await pushLog(managed, "buffered_event", {});

    expect(received).toHaveLength(0);
  });

  test("terminateSession emits session.terminated and cleans up subscribers", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received.push(event));

    await flamecast.terminateSession("s1");

    const terminatedEvents = received.filter(
      (e) => e.type === SESSION_EVENT_TYPES.SESSION_TERMINATED,
    );
    expect(terminatedEvents).toHaveLength(1);

    const rc = getRuntimeClient(flamecast);
    const sseSubscribers = Reflect.get(rc, "sseSubscribers") as Map<string, Set<unknown>>;
    expect(sseSubscribers.has("s1")).toBe(false);
  });

  test("subscriber errors do not disrupt other subscribers", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", () => {
      throw new Error("subscriber error");
    });
    flamecast.subscribe("s1", (event) => received.push(event));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      rc,
      "pushLog",
    );
    await pushLog(managed, "test_event", {});

    expect(received).toHaveLength(1);
  });

  test("bridge rpc events emit to subscribers via wireBridgeEvents", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    // Wire bridge events so rpc emissions flow to subscribers
    const wireBridgeEvents = getMethod<[unknown], void>(rc, "wireBridgeEvents");
    wireBridgeEvents(managed);

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received.push(event));

    // Simulate bridge emitting an rpc event
    managed.bridge.emit("rpc", {
      method: "test_method",
      direction: "client_to_agent",
      phase: "request",
      payload: { data: 1 },
    });

    // Allow async pushLog to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("rpc");
    expect(received[0].data).toMatchObject({ method: "test_method" });
  });

  test("pipeProviderEvents forwards events from a ReadableStream", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const rc = getRuntimeClient(flamecast);
    const managed = createManagedSession("s1");
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received.push(event));

    const event: SessionLog = {
      timestamp: new Date().toISOString(),
      type: SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT,
      data: { snapshot: { root: "/tmp", entries: [], truncated: false, maxEntries: 0 } },
    };

    const stream = new ReadableStream<SessionLog>({
      start(controller) {
        controller.enqueue(event);
        controller.close();
      },
    });

    const pipeProviderEvents = getMethod<[string, ReadableStream<SessionLog> | undefined], void>(
      rc,
      "pipeProviderEvents",
    );
    pipeProviderEvents("s1", stream);

    // Give the async reader a tick to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT);
  });
});

describe("createFileSystemEventStream", () => {
  test("emits filesystem.snapshot event when files change", async () => {
    const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-events-"));
    try {
      await writeFile(path.join(workspaceRoot, "initial.txt"), "hello");

      const stream = createFileSystemEventStream(workspaceRoot);
      expect(stream).toBeDefined();

      const received: SessionLog[] = [];
      const reader = stream!.getReader();
      const readLoop = async () => {
        const { value, done } = await reader.read();
        if (!done && value) {
          received.push(value);
        }
      };

      // Start reading (non-blocking)
      const readPromise = readLoop();

      // Create a new file to trigger the watcher
      await writeFile(path.join(workspaceRoot, "new-file.txt"), "world");

      // Wait for debounce (300ms) + margin
      await new Promise((resolve) => setTimeout(resolve, 600));
      await readPromise;

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0].type).toBe(SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT);
      expect(received[0].data.snapshot).toBeDefined();

      // Cleanup
      reader.releaseLock();
      await stream!.cancel();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns undefined for non-existent workspace root", () => {
    const stream = createFileSystemEventStream("/nonexistent/path/should/not/exist");
    expect(stream).toBeUndefined();
  });

  test("cancel stops the watcher and debounce timer", async () => {
    const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-events-"));
    try {
      const stream = createFileSystemEventStream(workspaceRoot);
      expect(stream).toBeDefined();

      // Trigger a file change to start a debounce timer
      await writeFile(path.join(workspaceRoot, "trigger.txt"), "data");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Cancel before debounce fires
      await stream!.cancel();

      // No errors should occur after cancel
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("debounces rapid file changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-events-"));
    try {
      const stream = createFileSystemEventStream(workspaceRoot);
      expect(stream).toBeDefined();

      const received: SessionLog[] = [];
      const reader = stream!.getReader();

      // Read events in background
      const readAll = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received.push(value);
        }
      })();

      // Create multiple files rapidly
      await mkdir(path.join(workspaceRoot, "subdir"));
      await writeFile(path.join(workspaceRoot, "a.txt"), "a");
      await writeFile(path.join(workspaceRoot, "b.txt"), "b");
      await writeFile(path.join(workspaceRoot, "c.txt"), "c");

      // Wait for debounce to fire
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Cancel to stop the read loop
      reader.releaseLock();
      await stream!.cancel();
      await readAll.catch(() => {});

      // Should produce a small number of events, not one per file op
      expect(received.length).toBeLessThanOrEqual(2);
      expect(received.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
