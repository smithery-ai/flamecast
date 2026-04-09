/**
 * Tests for handleSessionEvent — the control plane dispatcher that routes
 * session-host callback events to the appropriate in-process handlers.
 */
import { describe, it, expect, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { createTestStorage } from "./fixtures/test-helpers.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { SessionHostStartResponse } from "@flamecast/protocol/session-host";
import type { PermissionRequestContext } from "../src/flamecast/index.js";

// ---------------------------------------------------------------------------
// Mock runtime — returns canned /start responses
// ---------------------------------------------------------------------------

function createMockRuntime(): Runtime {
  return {
    async autoStart() { throw new Error("not supported"); },
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/start") && request.method === "POST") {
        const result: SessionHostStartResponse = {
          acpSessionId: sessionId,
          hostUrl: "http://localhost:9999",
          websocketUrl: "ws://localhost:9999",
        };
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/terminate") && request.method === "POST") {
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

/** Helper: create a Flamecast instance with a session already created. */
async function setup(
  handlers: Parameters<typeof Flamecast>[0] extends infer O
    ? Omit<O, "runtimes" | "storage">
    : never = {},
) {
  const storage = await createTestStorage();
  const flamecast = new Flamecast({
    storage,
    runtimes: { local: createMockRuntime() },
    ...handlers,
  });
  const session = await flamecast.createSession({
    spawn: { command: "echo", args: ["hello"] },
  });
  return { flamecast, session, storage };
}

// ===========================================================================
// 1. permission_request dispatch
// ===========================================================================

describe("handleSessionEvent — permission_request", () => {
  it("calls onPermissionRequest and returns optionId", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });
    const { flamecast, session } = await setup({ onPermissionRequest });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "permission_request",
        data: {
          requestId: "req-1",
          toolCallId: "tc-1",
          title: "Write to /tmp/out.txt",
          kind: "file_write",
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });

      expect(onPermissionRequest).toHaveBeenCalledOnce();
      expect(result).toEqual({ optionId: "allow" });

      const ctx = onPermissionRequest.mock.calls[0][0];
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.title).toBe("Write to /tmp/out.txt");
      expect(ctx.kind).toBe("file_write");
      expect(ctx.options).toHaveLength(2);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns deferred when no handler is registered", async () => {
    const { flamecast, session } = await setup();

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "permission_request",
        data: {
          requestId: "req-1",
          toolCallId: "tc-1",
          title: "Run command",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      expect(result).toEqual({ deferred: true });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns deferred when handler returns undefined", async () => {
    const onPermissionRequest = vi.fn(async () => undefined);
    const { flamecast, session } = await setup({ onPermissionRequest });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "permission_request",
        data: {
          requestId: "req-1",
          toolCallId: "tc-1",
          title: "Run command",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      expect(onPermissionRequest).toHaveBeenCalledOnce();
      expect(result).toEqual({ deferred: true });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns deferred when handler throws", async () => {
    const onPermissionRequest = vi.fn().mockRejectedValue(new Error("boom"));
    const { flamecast, session } = await setup({ onPermissionRequest });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "permission_request",
        data: {
          requestId: "req-1",
          toolCallId: "tc-1",
          title: "Run command",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      expect(result).toEqual({ deferred: true });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("deny() returns first reject option", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.deny();
    });
    const { flamecast, session } = await setup({ onPermissionRequest });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "permission_request",
        data: {
          requestId: "req-1",
          toolCallId: "tc-1",
          title: "Run command",
          options: [
            { optionId: "yes", name: "Yes", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        },
      });

      expect(result).toEqual({ optionId: "no" });
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 2. session_end dispatch
// ===========================================================================

describe("handleSessionEvent — session_end", () => {
  it("calls onSessionEnd with reason agent_exit", async () => {
    const onSessionEnd = vi.fn();
    const { flamecast, session } = await setup({ onSessionEnd });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "session_end",
        data: { exitCode: 0 },
      });

      expect(result).toEqual({ ok: true });
      expect(onSessionEnd).toHaveBeenCalledOnce();

      const ctx = onSessionEnd.mock.calls[0][0];
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.reason).toBe("agent_exit");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns ok when no handler registered", async () => {
    const { flamecast, session } = await setup();

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "session_end",
        data: { exitCode: 1 },
      });

      expect(result).toEqual({ ok: true });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("catches handler errors without breaking", async () => {
    const onSessionEnd = vi.fn().mockRejectedValue(new Error("handler boom"));
    const { flamecast, session } = await setup({ onSessionEnd });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "session_end",
        data: { exitCode: 1 },
      });

      expect(result).toEqual({ ok: true });
      expect(onSessionEnd).toHaveBeenCalledOnce();
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 3. agent_message dispatch
// ===========================================================================

describe("handleSessionEvent — agent_message", () => {
  it("calls onAgentMessage with session update data", async () => {
    const onAgentMessage = vi.fn();
    const { flamecast, session } = await setup({ onAgentMessage });

    const sessionUpdate = { update: "agent_message_chunk", text: "Hello" };

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "agent_message",
        data: { sessionUpdate },
      });

      expect(result).toEqual({ ok: true });
      expect(onAgentMessage).toHaveBeenCalledOnce();

      const ctx = onAgentMessage.mock.calls[0][0];
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.type).toBe("agent_message");
      expect(ctx.data).toEqual(sessionUpdate);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("catches handler errors", async () => {
    const onAgentMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const { flamecast, session } = await setup({ onAgentMessage });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "agent_message",
        data: { sessionUpdate: {} },
      });

      expect(result).toEqual({ ok: true });
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 4. error dispatch
// ===========================================================================

describe("handleSessionEvent — error", () => {
  it("calls onError with Error wrapping the message", async () => {
    const onError = vi.fn();
    const { flamecast, session } = await setup({ onError });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "error",
        data: { message: "Something went wrong" },
      });

      expect(result).toEqual({ ok: true });
      expect(onError).toHaveBeenCalledOnce();

      const ctx = onError.mock.calls[0][0];
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.error).toBeInstanceOf(Error);
      expect(ctx.error.message).toBe("Something went wrong");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("catches handler errors", async () => {
    const onError = vi.fn().mockRejectedValue(new Error("handler boom"));
    const { flamecast, session } = await setup({ onError });

    try {
      const result = await flamecast.handleSessionEvent(session.id, {
        type: "error",
        data: { message: "original error" },
      });

      expect(result).toEqual({ ok: true });
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 5. Edge cases
// ===========================================================================

describe("handleSessionEvent — edge cases", () => {
  it("returns ok for unknown event types", async () => {
    const { flamecast, session } = await setup();

    try {
      // Simulate a future event type the server doesn't know about yet
      const fakeEvent = JSON.parse(
        JSON.stringify({ type: "unknown_future_event", data: { foo: "bar" } }),
      );
      const result = await flamecast.handleSessionEvent(session.id, fakeEvent);

      expect(result).toEqual({ ok: true });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("skips handlers gracefully when session not in storage", async () => {
    const onSessionEnd = vi.fn();
    const { flamecast } = await setup({ onSessionEnd });

    try {
      const result = await flamecast.handleSessionEvent("nonexistent-session-id", {
        type: "session_end",
        data: { exitCode: 0 },
      });

      // buildSessionContext returns null → handler not called → still returns ok
      expect(result).toEqual({ ok: true });
      expect(onSessionEnd).not.toHaveBeenCalled();
    } finally {
      await flamecast.shutdown();
    }
  });
});
