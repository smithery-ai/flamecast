/* oxlint-disable no-type-assertion/no-type-assertion */
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { LocalRuntimeClient } from "../src/runtime/local.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { SessionLog } from "../src/shared/session.js";

type PromptHandler = (params: acp.PromptRequest) => Promise<acp.PromptResponse>;

type MockBridge = EventEmitter & {
  isInitialized: boolean;
  prompt: (params: acp.PromptRequest) => Promise<acp.PromptResponse>;
  flush: () => Promise<void>;
  resolvePermission: () => void;
  initialize: () => Promise<unknown>;
  newSession: () => Promise<unknown>;
};

function createMockBridge(promptHandler?: PromptHandler): MockBridge {
  const emitter = new EventEmitter();
  let _initialized = promptHandler != null;
  return Object.assign(emitter, {
    get isInitialized() {
      return _initialized;
    },
    set isInitialized(val: boolean) {
      _initialized = val;
    },
    prompt: promptHandler
      ? async (params: acp.PromptRequest) => promptHandler(params)
      : async () => {
          throw new Error("not initialized");
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
  pendingLogs: SessionLog[];
  bufferPendingLogs: boolean;
  bridge: MockBridge;
  terminate: () => Promise<void>;
  inFlightPromptId: string | null;
  promptQueue: Array<{ queueId: string; text: string; enqueuedAt: string }>;
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

function createManagedSession(id: string, prompt?: PromptHandler) {
  return {
    id,
    workspaceRoot: process.cwd(),
    pendingLogs: [] as SessionLog[],
    bufferPendingLogs: false,
    bridge: createMockBridge(prompt),
    terminate: vi.fn(async () => {}),
    lastFileSystemSnapshot: null,
    inFlightPromptId: null,
    promptQueue: [],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prompt queue", () => {
  test("first prompt to idle session executes immediately", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const managed = createManagedSession("s1", async () => ({
      stopReason: "end_turn" as const,
    }));
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const result = await flamecast.promptSession("s1", "hello");

    expect(result).toEqual(expect.objectContaining({ stopReason: "end_turn" }));
    expect("queued" in result).toBe(false);
    expect(managed.inFlightPromptId).toBeNull();
  });

  test("second prompt while busy is queued", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();
    const managed = createManagedSession("s1", async () => d.promise);
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    // Start first prompt (will block)
    const firstPromise = flamecast.promptSession("s1", "first");

    // Wait for in-flight to be set
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    // Second prompt should be queued
    const queueResult = await flamecast.promptSession("s1", "second");

    expect(queueResult).toEqual({
      queued: true,
      queueId: expect.any(String),
      position: 1,
    });
    expect(managed.promptQueue).toHaveLength(1);

    // Cleanup: resolve the first prompt
    d.resolve({ stopReason: "end_turn" });
    await firstPromise;
  });

  test("queued prompt auto-executes after turn completes", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const calls: string[] = [];
    const d = deferred<acp.PromptResponse>();
    let callCount = 0;

    const managed = createManagedSession("s1", async (params) => {
      const text = params.prompt[0].type === "text" ? params.prompt[0].text : "";
      calls.push(text);
      if (callCount++ === 0) {
        return d.promise;
      }
      return { stopReason: "end_turn" as const };
    });
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "second");

    // Resolve first prompt — should trigger dequeue
    d.resolve({ stopReason: "end_turn" });
    await firstPromise;

    // Wait for dequeue to complete (fire-and-forget, so poll)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });

    expect(calls).toEqual(["first", "second"]);

    // Check logs contain queue events
    const logs = await storage.getLogs("s1");
    const queuedLogs = logs.filter((l) => l.type === "prompt_queued");
    const dequeuedLogs = logs.filter((l) => l.type === "prompt_dequeued");
    expect(queuedLogs).toHaveLength(1);
    expect(dequeuedLogs).toHaveLength(1);
  });

  test("FIFO ordering preserved", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const calls: string[] = [];
    const d = deferred<acp.PromptResponse>();
    let callCount = 0;

    const managed = createManagedSession("s1", async (params) => {
      const text = params.prompt[0].type === "text" ? params.prompt[0].text : "";
      calls.push(text);
      if (callCount++ === 0) {
        return d.promise;
      }
      return { stopReason: "end_turn" as const };
    });
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "second");
    await flamecast.promptSession("s1", "third");
    await flamecast.promptSession("s1", "fourth");

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;

    await vi.waitFor(() => {
      expect(managed.promptQueue).toHaveLength(0);
    });

    expect(calls).toEqual(["first", "second", "third", "fourth"]);
  });

  test("queue overflow throws error", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();

    const managed = createManagedSession("s1", async () => d.promise);
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    // Start first prompt
    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    // Fill queue to max (50)
    for (let i = 0; i < 50; i++) {
      await flamecast.promptSession("s1", `queued-${i}`);
    }

    // 51st should throw
    await expect(flamecast.promptSession("s1", "overflow")).rejects.toThrow("Prompt queue is full");

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;
  });

  test("cancel a queued prompt", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();

    const managed = createManagedSession("s1", async () => d.promise);
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    const queueResult = await flamecast.promptSession("s1", "to-cancel");
    expect("queued" in queueResult && queueResult.queued).toBe(true);
    const queueId = "queueId" in queueResult ? queueResult.queueId : "";

    await flamecast.cancelQueuedPrompt("s1", queueId);

    expect(managed.promptQueue).toHaveLength(0);
    const logs = await storage.getLogs("s1");
    expect(logs.some((l) => l.type === "prompt_cancelled")).toBe(true);

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;
  });

  test("cancel non-existent queueId throws", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const managed = createManagedSession("s1", async () => ({
      stopReason: "end_turn" as const,
    }));
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    await expect(flamecast.cancelQueuedPrompt("s1", "nonexistent")).rejects.toThrow(
      'Queued prompt "nonexistent" not found',
    );
  });

  test("terminate clears queue", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();

    const managed = createManagedSession("s1", async () => d.promise);
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "queued-1");
    await flamecast.promptSession("s1", "queued-2");
    expect(managed.promptQueue).toHaveLength(2);

    // Resolve in-flight so terminate doesn't hang
    d.resolve({ stopReason: "end_turn" });
    await firstPromise;

    // Wait for dequeue to start, then terminate
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).toBeNull();
    });

    // Re-setup for terminate test: manually add items back
    managed.promptQueue = [
      { queueId: "q1", text: "a", enqueuedAt: "2024-01-01T00:00:00.000Z" },
      { queueId: "q2", text: "b", enqueuedAt: "2024-01-01T00:00:00.000Z" },
    ];
    // Re-register since dequeue may have removed it
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);

    await flamecast.terminateSession("s1");

    const logs = await storage.getLogs("s1");
    const clearLogs = logs.filter((l) => l.type === "queue_cleared");
    expect(clearLogs).toHaveLength(1);
    expect(clearLogs[0].data).toEqual({ reason: "terminated", droppedCount: 2 });
  });

  test("error in dequeued prompt does not break chain", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const calls: string[] = [];
    const d = deferred<acp.PromptResponse>();
    let callCount = 0;

    const managed = createManagedSession("s1", async (params) => {
      const text = params.prompt[0].type === "text" ? params.prompt[0].text : "";
      calls.push(text);
      callCount++;
      if (callCount === 1) {
        return d.promise; // first prompt blocks
      }
      if (callCount === 2) {
        throw new Error("agent error"); // second (dequeued) fails
      }
      return { stopReason: "end_turn" as const }; // third succeeds
    });
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "will-fail");
    await flamecast.promptSession("s1", "will-succeed");

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;

    await vi.waitFor(() => {
      expect(managed.promptQueue).toHaveLength(0);
      expect(managed.inFlightPromptId).toBeNull();
    });

    expect(calls).toEqual(["first", "will-fail", "will-succeed"]);

    const logs = await storage.getLogs("s1");
    expect(logs.some((l) => l.type === "prompt_error")).toBe(true);
  });

  test("getQueueState returns correct shape", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();

    const managed = createManagedSession("s1", async () => d.promise);
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "queued-1");
    await flamecast.promptSession("s1", "queued-2");

    const state = await flamecast.getQueueState("s1");
    expect(state.processing).toBe(true);
    expect(state.size).toBe(2);
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toEqual(expect.objectContaining({ text: "queued-1", position: 1 }));
    expect(state.items[1]).toEqual(expect.objectContaining({ text: "queued-2", position: 2 }));

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;
  });

  test("dequeued prompt errors when connection lost", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();
    let callCount = 0;

    const managed = createManagedSession("s1", async () => {
      callCount++;
      if (callCount === 1) return d.promise;
      return { stopReason: "end_turn" as const };
    });
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "queued");

    // Mark bridge as not initialized before the queued prompt can execute
    managed.bridge.isInitialized = false;

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;

    // Wait for dequeue attempt and error logging to complete
    await vi.waitFor(async () => {
      const logs = await storage.getLogs("s1");
      expect(logs.some((l) => l.type === "prompt_error")).toBe(true);
    });
  });

  test("session snapshot includes promptQueue", async () => {
    const flamecast = new Flamecast({ storage: "memory", handleSignals: false });
    const storage = attachStorage(flamecast);
    const d = deferred<acp.PromptResponse>();

    const managed = createManagedSession("s1", async () => d.promise);
    getRuntimeMap(flamecast).set("s1", managed as unknown as ManagedSessionLike);
    await storage.createSession(createMeta("s1"));

    const firstPromise = flamecast.promptSession("s1", "first");
    await vi.waitFor(() => {
      expect(managed.inFlightPromptId).not.toBeNull();
    });

    await flamecast.promptSession("s1", "queued");

    const session = await flamecast.getSession("s1");
    expect(session.promptQueue).not.toBeNull();
    expect(session.promptQueue!.processing).toBe(true);
    expect(session.promptQueue!.size).toBe(1);

    d.resolve({ stopReason: "end_turn" });
    await firstPromise;
  });
});
