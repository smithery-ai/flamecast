import { describe, it, expect, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { createTestStorage } from "./fixtures/test-helpers.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { PermissionRequestContext, SessionEndContext } from "../src/flamecast/index.js";
import type { SessionHostStartResponse } from "@flamecast/protocol/session-host";

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
  it("infers runtime names from runtimes map", async () => {
    // This test primarily verifies compile-time correctness.
    // If it compiles, the generics work.
    const flamecast = new Flamecast({
      storage: await createTestStorage(),
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
    }
  });

  it("accepts event handlers with generic context", async () => {
    const onSessionEnd = vi.fn<[SessionEndContext<{ local: Runtime }>]>();

    const flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { local: createMockRuntime() },
      onSessionEnd,
    });

    try {
      // Verify handlers are stored
      expect(flamecast.handlers.onSessionEnd).toBe(onSessionEnd);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("defaults to Record<string, Runtime> when no generic specified", async () => {
    // Unparameterized Flamecast should still work (backward compatible)
    const flamecast: Flamecast = new Flamecast({
      storage: await createTestStorage(),
      runtimes: { local: createMockRuntime() },
    });

    try {
      const templates = await flamecast.listAgentTemplates();
      expect(templates).toEqual([]);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 2. onSessionEnd handler
// ===========================================================================

describe("onSessionEnd handler", () => {
  it("is called when a session is terminated", async () => {
    const onSessionEnd = vi.fn<[SessionEndContext<{ local: Runtime }>]>();

    const storage = await createTestStorage();
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
    }
  });

  it("is not called when no handler is registered", async () => {
    const storage = await createTestStorage();
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
    }
  });

  it("handler errors are caught and do not break termination", async () => {
    const onSessionEnd = vi.fn().mockRejectedValue(new Error("handler boom"));

    const storage = await createTestStorage();
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
    }
  });
});

// ===========================================================================
// 3. onPermissionRequest handler (via handlePermissionRequest)
// ===========================================================================

describe("onPermissionRequest handler", () => {
  it("is invoked via handlePermissionRequest and returns handler response", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });

    const storage = await createTestStorage();
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
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
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
    }
  });

  it("deny() convenience returns first reject option", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.deny();
    });

    const storage = await createTestStorage();
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
          { optionId: "yes", name: "Yes", kind: "allow_once" },
          { optionId: "no", name: "No", kind: "reject_once" },
        ],
      });

      expect(response).toEqual({ optionId: "no" });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns undefined when no handler is registered", async () => {
    const storage = await createTestStorage();
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
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      expect(response).toBeUndefined();
    } finally {
      await flamecast.shutdown();
    }
  });

  it("handler errors are caught and return undefined", async () => {
    const onPermissionRequest = vi.fn().mockRejectedValue(new Error("handler boom"));

    const storage = await createTestStorage();
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
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      expect(response).toBeUndefined();
      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("allow() returns cancelled when no approve option exists", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });

    const storage = await createTestStorage();
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
        options: [{ optionId: "no", name: "No", kind: "reject_once" }],
      });

      // No approve option => allow() falls back to cancelled
      expect(response).toEqual({ outcome: "cancelled" });
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 4. handlers property is exposed and readonly
// ===========================================================================

describe("handlers property", () => {
  it("exposes all registered handlers", async () => {
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
    }
  });
});
