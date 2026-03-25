import { describe, expect, vi } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { Runtime } from "../src/flamecast/runtime.js";
import type { PermissionRequestContext, SessionEndContext } from "../src/flamecast/index.js";
import type { SessionHostStartResponse } from "../src/shared/session-host-protocol.js";

type AlchemyTestFactory = (meta: ImportMeta, opts: { prefix: string }) => typeof describe;

function isAlchemyTestFactory(value: unknown): value is AlchemyTestFactory {
  return typeof value === "function";
}

const maybeAlchemyTest = Reflect.get(alchemy, "test");

if (!isAlchemyTestFactory(maybeAlchemyTest)) {
  throw new Error("alchemy.test is unavailable");
}

const test = maybeAlchemyTest(import.meta, { prefix: "event-handlers" });

// ---------------------------------------------------------------------------
// Mock Runtime
// ---------------------------------------------------------------------------

function createMockRuntime(): Runtime {
  const sessions = new Map<string, { hostUrl: string; websocketUrl: string }>();

  return {
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.endsWith("/start") && request.method === "POST") {
        const hostUrl = `http://localhost:9999`;
        const websocketUrl = `ws://localhost:9999/ws`;
        sessions.set(sessionId, { hostUrl, websocketUrl });

        const result: SessionHostStartResponse = {
          acpSessionId: sessionId,
          hostUrl,
          websocketUrl,
        };

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path.endsWith("/terminate") && request.method === "POST") {
        sessions.delete(sessionId);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

// ===========================================================================
// 1. Generic Flamecast<R> — compile-time type safety
// ===========================================================================

describe("generic Flamecast<R> type safety", () => {
  test("infers runtime names from runtimes map", async (scope: unknown) => {
    // This test primarily verifies compile-time correctness.
    // If it compiles, the generics work.
    const flamecast = new Flamecast({
      runtimes: {
        local: createMockRuntime(),
        cloud: createMockRuntime(),
      },
    });

    try {
      // Verify the instance is usable and runtimes are registered
      const templates = await flamecast.listAgentTemplates();
      expect(templates).toEqual([]);
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("accepts event handlers with generic context", async (scope: unknown) => {
    const onSessionEnd = vi.fn<[SessionEndContext<{ local: Runtime }>]>();

    const flamecast = new Flamecast({
      runtimes: { local: createMockRuntime() },
      onSessionEnd,
    });

    try {
      // Verify handlers are stored
      expect(flamecast.handlers.onSessionEnd).toBe(onSessionEnd);
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("defaults to Record<string, Runtime> when no generic specified", async (scope: unknown) => {
    // Unparameterized Flamecast should still work (backward compatible)
    const flamecast: Flamecast = new Flamecast({
      runtimes: { local: createMockRuntime() },
    });

    try {
      const templates = await flamecast.listAgentTemplates();
      expect(templates).toEqual([]);
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });
});

// ===========================================================================
// 2. onSessionEnd handler
// ===========================================================================

describe("onSessionEnd handler", () => {
  test("is called when a session is terminated", async (scope: unknown) => {
    const onSessionEnd = vi.fn<[SessionEndContext<{ local: Runtime }>]>();

    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      onSessionEnd,
    });

    try {
      // Create a session
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // Terminate it
      await flamecast.terminateSession(session.id);

      // Verify the handler was called
      expect(onSessionEnd).toHaveBeenCalledTimes(1);

      const ctx = onSessionEnd.mock.calls[0][0];
      expect(ctx.reason).toBe("terminated");
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.session.agentName).toBe("echo hello");
      expect(ctx.session.spawn).toEqual({ command: "echo", args: ["hello"] });
      expect(ctx.session.startedAt).toBeTruthy();
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("is not called when no handler is registered", async (scope: unknown) => {
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // Should not throw even without a handler
      await flamecast.terminateSession(session.id);
      expect(flamecast.handlers.onSessionEnd).toBeUndefined();
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("handler errors are caught and do not break termination", async (scope: unknown) => {
    const onSessionEnd = vi.fn().mockRejectedValue(new Error("handler boom"));

    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      onSessionEnd,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // Termination should succeed even though the handler throws
      await flamecast.terminateSession(session.id);

      expect(onSessionEnd).toHaveBeenCalledTimes(1);

      // Session should be terminated in storage
      const meta = await storage.getSessionMeta(session.id);
      expect(meta?.status).toBe("killed");
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });
});

// ===========================================================================
// 3. onPermissionRequest handler (via handlePermissionRequest)
// ===========================================================================

describe("onPermissionRequest handler", () => {
  test("is invoked via handlePermissionRequest and returns handler response", async (scope: unknown) => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });

    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-1",
        toolCallId: "tool-1",
        title: "Allow file write",
        kind: "file_write",
        options: [
          { optionId: "allow", name: "Allow", kind: "approve" },
          { optionId: "deny", name: "Deny", kind: "reject" },
        ],
      });

      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
      expect(response).toEqual({ optionId: "allow" });

      // Verify context fields
      const ctx = onPermissionRequest.mock.calls[0][0];
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.requestId).toBe("req-1");
      expect(ctx.toolCallId).toBe("tool-1");
      expect(ctx.title).toBe("Allow file write");
      expect(ctx.kind).toBe("file_write");
      expect(ctx.options).toHaveLength(2);
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("deny() convenience returns first reject option", async (scope: unknown) => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.deny();
    });

    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-2",
        toolCallId: "tool-2",
        title: "Run shell command",
        kind: "command",
        options: [
          { optionId: "yes", name: "Yes", kind: "approve" },
          { optionId: "no", name: "No", kind: "reject" },
        ],
      });

      expect(response).toEqual({ optionId: "no" });
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("returns undefined when no handler is registered", async (scope: unknown) => {
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-1",
        toolCallId: "tool-1",
        title: "Allow file write",
        options: [{ optionId: "allow", name: "Allow", kind: "approve" }],
      });

      expect(response).toBeUndefined();
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("handler errors are caught and return undefined", async (scope: unknown) => {
    const onPermissionRequest = vi.fn().mockRejectedValue(new Error("handler boom"));

    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-1",
        toolCallId: "tool-1",
        title: "Allow file write",
        options: [{ optionId: "allow", name: "Allow", kind: "approve" }],
      });

      expect(response).toBeUndefined();
      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });

  test("allow() returns cancelled when no approve option exists", async (scope: unknown) => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });

    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: createMockRuntime() },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-1",
        toolCallId: "tool-1",
        title: "Allow file write",
        options: [{ optionId: "no", name: "No", kind: "reject" }],
      });

      // No approve option => allow() falls back to cancelled
      expect(response).toEqual({ outcome: "cancelled" });
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });
});

// ===========================================================================
// 4. handlers property is exposed and readonly
// ===========================================================================

describe("handlers property", () => {
  test("exposes all registered handlers", async (scope: unknown) => {
    const onPermissionRequest = vi.fn();
    const onSessionEnd = vi.fn();

    const flamecast = new Flamecast({
      runtimes: { local: createMockRuntime() },
      onPermissionRequest,
      onSessionEnd,
    });

    try {
      expect(flamecast.handlers.onPermissionRequest).toBe(onPermissionRequest);
      expect(flamecast.handlers.onSessionEnd).toBe(onSessionEnd);
      expect(flamecast.handlers.onAgentMessage).toBeUndefined();
      expect(flamecast.handlers.onError).toBeUndefined();
    } finally {
      await flamecast.shutdown();
      await alchemy.destroy(scope);
    }
  });
});
