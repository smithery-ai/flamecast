/* oxlint-disable no-type-assertion/no-type-assertion */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { SessionLog } from "../src/shared/session.js";
import { SESSION_EVENT_TYPES } from "../src/shared/session.js";

type ManagedSessionLike = {
  id: string;
  workspaceRoot: string;
  transport: {
    input: WritableStream<Uint8Array>;
    output: ReadableStream<Uint8Array>;
    dispose?: () => Promise<void>;
  };
  terminate: () => Promise<void>;
  fileSystemWatcher: unknown;
  runtime: {
    connection: null;
    sessionTextChunkLogBuffer: null;
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

function createManagedSession(id: string, workspaceRoot = process.cwd()) {
  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  return {
    id,
    workspaceRoot,
    pendingLogs: [] as SessionLog[],
    bufferPendingLogs: false,
    transport: {
      input: passthrough.writable,
      output: passthrough.readable,
    },
    terminate: vi.fn(async () => {}),
    fileSystemWatcher: null,
    runtime: {
      connection: null,
      sessionTextChunkLogBuffer: null,
    },
  };
}

function attachStorage(flamecast: Flamecast, storage = new MemoryFlamecastStorage()) {
  Reflect.set(flamecast, "storage", storage);
  Reflect.set(flamecast, "readyPromise", Promise.resolve());
  return storage;
}

function getRuntimeMap(flamecast: Flamecast) {
  return Reflect.get(flamecast, "runtimes") as Map<string, ManagedSessionLike>;
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session event emission", () => {
  test("subscribe receives events from pushLog", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => {
      received.push(event);
    });

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      flamecast,
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
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    const unsubscribe = flamecast.subscribe("s1", (event) => {
      received.push(event);
    });

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      flamecast,
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
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received1: SessionLog[] = [];
    const received2: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received1.push(event));
    flamecast.subscribe("s1", (event) => received2.push(event));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      flamecast,
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
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      flamecast,
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
    const managed = createManagedSession("s1");
    // bufferPendingLogs defaults to true for new sessions
    managed.bufferPendingLogs = true;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received.push(event));

    const pushLog = getMethod<[unknown, string, Record<string, unknown>], Promise<SessionLog>>(
      flamecast,
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

    // Subscriber set should be cleaned up
    const sseSubscribers = Reflect.get(flamecast, "sseSubscribers") as Map<string, Set<unknown>>;
    expect(sseSubscribers.has("s1")).toBe(false);
  });

  test("subscriber errors do not disrupt other subscribers", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
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
      flamecast,
      "pushLog",
    );
    await pushLog(managed, "test_event", {});

    expect(received).toHaveLength(1);
  });

  test("pushRpcLog also emits events", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const managed = createManagedSession("s1");
    managed.bufferPendingLogs = false;
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const received: SessionLog[] = [];
    flamecast.subscribe("s1", (event) => received.push(event));

    const pushRpcLog = getMethod<[unknown, string, string, string, unknown], Promise<void>>(
      flamecast,
      "pushRpcLog",
    );
    await pushRpcLog(managed, "test_method", "client_to_agent", "request", { data: 1 });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("rpc");
    expect(received[0].data).toMatchObject({ method: "test_method" });
  });
});

describe("filesystem watcher", () => {
  test("emits filesystem.snapshot event when files change", async () => {
    const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-events-"));
    try {
      await writeFile(path.join(workspaceRoot, "initial.txt"), "hello");

      const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
      const storage = attachStorage(flamecast);
      const managed = createManagedSession("s1", workspaceRoot);
      managed.bufferPendingLogs = false;
      getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
      await storage.createSession(createMeta("s1"));

      const received: SessionLog[] = [];
      flamecast.subscribe("s1", (event) => received.push(event));

      // Start the filesystem watcher
      const startWatcher = getMethod<[unknown], void>(flamecast, "startFileSystemWatcher");
      startWatcher(managed);

      // Create a new file to trigger the watcher
      await writeFile(path.join(workspaceRoot, "new-file.txt"), "world");

      // Wait for debounce (300ms) + some margin
      await new Promise((resolve) => setTimeout(resolve, 600));

      const fsEvents = received.filter((e) => e.type === SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT);
      expect(fsEvents.length).toBeGreaterThanOrEqual(1);

      const snapshot = fsEvents[0].data.snapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot).toHaveProperty("entries");

      // Clean up watcher
      const stopWatcher = getMethod<[unknown], void>(flamecast, "stopFileSystemWatcher");
      stopWatcher(managed);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("stopFileSystemWatcher cleans up watcher and debounce timer", async () => {
    const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-events-"));
    try {
      const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
      const storage = attachStorage(flamecast);
      const managed = createManagedSession("s1", workspaceRoot);
      managed.bufferPendingLogs = false;
      getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
      await storage.createSession(createMeta("s1"));

      const received: SessionLog[] = [];
      flamecast.subscribe("s1", (event) => received.push(event));

      const startWatcher = getMethod<[unknown], void>(flamecast, "startFileSystemWatcher");
      startWatcher(managed);
      expect(managed.fileSystemWatcher).not.toBeNull();

      // Trigger a file change to start a debounce timer
      await writeFile(path.join(workspaceRoot, "trigger.txt"), "data");
      // Give fs.watch a moment to fire (but less than debounce timeout)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop watcher while debounce timer is still pending
      const stopWatcher = getMethod<[unknown], void>(flamecast, "stopFileSystemWatcher");
      stopWatcher(managed);
      expect(managed.fileSystemWatcher).toBeNull();

      // Verify the debounce timer was cleared (no event should fire)
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(received).toHaveLength(0);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("skips watcher for non-existent workspace root", () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    attachStorage(flamecast);
    const managed = createManagedSession("s1", "/nonexistent/path/should/not/exist");

    const startWatcher = getMethod<[unknown], void>(flamecast, "startFileSystemWatcher");
    startWatcher(managed);

    expect(managed.fileSystemWatcher).toBeNull();
  });

  test("debounces rapid file changes into a single event", async () => {
    const workspaceRoot = await mkdtemp(path.join(process.cwd(), ".flamecast-events-"));
    try {
      const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
      const storage = attachStorage(flamecast);
      const managed = createManagedSession("s1", workspaceRoot);
      managed.bufferPendingLogs = false;
      getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
      await storage.createSession(createMeta("s1"));

      const received: SessionLog[] = [];
      flamecast.subscribe("s1", (event) => received.push(event));

      const startWatcher = getMethod<[unknown], void>(flamecast, "startFileSystemWatcher");
      startWatcher(managed);

      // Create multiple files rapidly
      await mkdir(path.join(workspaceRoot, "subdir"));
      await writeFile(path.join(workspaceRoot, "a.txt"), "a");
      await writeFile(path.join(workspaceRoot, "b.txt"), "b");
      await writeFile(path.join(workspaceRoot, "c.txt"), "c");

      // Wait for debounce to fire
      await new Promise((resolve) => setTimeout(resolve, 600));

      const fsEvents = received.filter((e) => e.type === SESSION_EVENT_TYPES.FILESYSTEM_SNAPSHOT);
      // Should produce a small number of events (1 or 2) — not one per file operation
      expect(fsEvents.length).toBeLessThanOrEqual(2);
      expect(fsEvents.length).toBeGreaterThanOrEqual(1);

      const stopWatcher = getMethod<[unknown], void>(flamecast, "stopFileSystemWatcher");
      stopWatcher(managed);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
