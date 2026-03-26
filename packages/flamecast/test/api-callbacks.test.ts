/**
 * API route integration tests for the callback and prompt endpoints.
 *
 * Tests POST /api/agents/:id/events and POST /api/agents/:id/prompts
 * via the Hono test client (no real HTTP server).
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi } from "../src/flamecast/api.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { SessionHostStartResponse } from "@flamecast/protocol/session-host";
import type { PermissionRequestContext } from "../src/flamecast/index.js";

// ---------------------------------------------------------------------------
// Mock runtime — tracks /start bodies and handles /prompt
// ---------------------------------------------------------------------------

function createMockRuntime() {
  const startBodies: Record<string, unknown>[] = [];
  let promptHandler: ((body: Record<string, unknown>) => Response) | null = null;

  const runtime: Runtime = {
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname.endsWith("/start") && request.method === "POST") {
        const body = await request.json();
        startBodies.push(body);
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

      if (url.pathname.endsWith("/prompt") && request.method === "POST") {
        const body = await request.json();
        if (promptHandler) return promptHandler(body);
        return new Response(JSON.stringify({ stopReason: "end_turn" }), {
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

  return {
    runtime,
    startBodies,
    setPromptHandler(fn: (body: Record<string, unknown>) => Response) {
      promptHandler = fn;
    },
  };
}

/** Build a raw fetch function against the Hono app (for endpoints not in the typed client). */
function createFetch(flamecast: Flamecast) {
  const api = createApi(flamecast);
  const app = new Hono().route("/api", api);
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init));
}

// ===========================================================================
// POST /api/agents/:id/events
// ===========================================================================

describe("POST /api/agents/:id/events", () => {
  it("handles permission_request and returns handler response", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });

    const { runtime } = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onPermissionRequest,
    });
    const fetch = createFetch(flamecast);

    try {
      // Create a session first
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo", args: ["hi"] } }),
      });
      const session = await createRes.json();

      // POST a permission_request event
      const res = await fetch(`/api/agents/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "permission_request",
          data: {
            requestId: "req-1",
            toolCallId: "tc-1",
            title: "Write file",
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ optionId: "allow" });
      expect(onPermissionRequest).toHaveBeenCalledOnce();
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns deferred when no handler is registered", async () => {
    const { runtime } = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const fetch = createFetch(flamecast);

    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await createRes.json();

      const res = await fetch(`/api/agents/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "permission_request",
          data: {
            requestId: "req-1",
            toolCallId: "tc-1",
            title: "Run command",
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deferred: true });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("handles session_end event", async () => {
    const onSessionEnd = vi.fn();
    const { runtime } = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onSessionEnd,
    });
    const fetch = createFetch(flamecast);

    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await createRes.json();

      const res = await fetch(`/api/agents/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "session_end",
          data: { exitCode: 0 },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(onSessionEnd).toHaveBeenCalledOnce();
      expect(onSessionEnd.mock.calls[0][0].reason).toBe("agent_exit");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("handles error event", async () => {
    const onError = vi.fn();
    const { runtime } = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onError,
    });
    const fetch = createFetch(flamecast);

    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await createRes.json();

      const res = await fetch(`/api/agents/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "error",
          data: { message: "Something broke" },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].error.message).toBe("Something broke");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("rejects events without type field (400)", async () => {
    const { runtime } = createMockRuntime();
    const flamecast = new Flamecast({ runtimes: { local: runtime } });
    const fetch = createFetch(flamecast);

    try {
      const res = await fetch("/api/agents/some-id/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { foo: "bar" } }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/missing type/i);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("rejects events without data field (400)", async () => {
    const { runtime } = createMockRuntime();
    const flamecast = new Flamecast({ runtimes: { local: runtime } });
    const fetch = createFetch(flamecast);

    try {
      const res = await fetch("/api/agents/some-id/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "session_end" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/missing.*data/i);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// POST /api/agents/:id/prompts
// ===========================================================================

describe("POST /api/agents/:id/prompts", () => {
  it("proxies prompt to session-host and returns result", async () => {
    const mock = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: mock.runtime },
    });
    const fetch = createFetch(flamecast);

    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await createRes.json();

      const res = await fetch(`/api/agents/${session.id}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello agent" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("stopReason", "end_turn");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("rejects missing text field (400)", async () => {
    const { runtime } = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const fetch = createFetch(flamecast);

    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await createRes.json();

      const res = await fetch(`/api/agents/${session.id}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/text/i);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("rejects non-string text field (400)", async () => {
    const { runtime } = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });
    const fetch = createFetch(flamecast);

    try {
      const createRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await createRes.json();

      const res = await fetch(`/api/agents/${session.id}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: 42 }),
      });

      expect(res.status).toBe(400);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returns 404 for unknown session", async () => {
    const { runtime } = createMockRuntime();
    const flamecast = new Flamecast({ runtimes: { local: runtime } });
    const fetch = createFetch(flamecast);

    try {
      const res = await fetch("/api/agents/nonexistent/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });

      expect(res.status).toBe(404);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// callbackUrl auto-detection
// ===========================================================================

describe("callbackUrl plumbing", () => {
  it("passes sessionId and callbackUrl in /start body", async () => {
    const mock = createMockRuntime();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: mock.runtime },
    });
    const fetch = createFetch(flamecast);

    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spawn: { command: "echo" } }),
      });
      const session = await res.json();

      // The mock runtime captured the /start body
      expect(mock.startBodies).toHaveLength(1);
      const startBody = mock.startBodies[0];

      // sessionId should be the Flamecast-level ID
      expect(startBody.sessionId).toBe(session.id);

      // callbackUrl should be auto-detected from the request
      expect(startBody.callbackUrl).toMatch(/^http:\/\/localhost.*\/api$/);
    } finally {
      await flamecast.shutdown();
    }
  });
});
