import { afterEach, describe, expect, it, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { createTestStorage } from "./fixtures/test-helpers.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { SessionHostStartResponse } from "@flamecast/protocol/session-host";

function createRecoverableRuntime(): Runtime & {
  reconnectCalls: string[];
  promptBodies: Array<{ sessionId: string; text: string }>;
} {
  const liveSessions = new Map<string, { hostUrl: string; websocketUrl: string }>();
  const reconnectCalls: string[] = [];
  const promptBodies: Array<{ sessionId: string; text: string }> = [];

  return {
    reconnectCalls,
    promptBodies,
    async fetchSession(sessionId, request) {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/start") && request.method === "POST") {
        const result: SessionHostStartResponse = {
          acpSessionId: `acp-${sessionId}`,
          hostUrl: `https://runtime.example/${sessionId}`,
          websocketUrl: `wss://runtime.example/${sessionId}`,
        };
        liveSessions.set(sessionId, {
          hostUrl: result.hostUrl,
          websocketUrl: result.websocketUrl,
        });
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const live = liveSessions.get(sessionId);
      if (!live) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path.endsWith("/prompt") && request.method === "POST") {
        const body: { text?: string } = await request.json();
        promptBodies.push({ sessionId, text: body.text ?? "" });
        return new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path.includes("/permissions/") && request.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path.endsWith("/terminate") && request.method === "POST") {
        liveSessions.delete(sessionId);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path.endsWith("/health") && request.method === "GET") {
        return new Response(JSON.stringify({ status: "running" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    },
    getRuntimeMeta(sessionId) {
      const live = liveSessions.get(sessionId);
      return live ? { ...live, sandboxId: "sandbox-1", instanceName: "e2b", port: 9000 } : null;
    },
    async reconnect(sessionId, runtimeMeta) {
      reconnectCalls.push(sessionId);
      const hostUrl = typeof runtimeMeta?.hostUrl === "string" ? runtimeMeta.hostUrl : undefined;
      return Boolean(hostUrl) && liveSessions.has(sessionId);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stateless control plane", () => {
  it("lazy-recovers a session from storage for prompt proxying", async () => {
    const storage = await createTestStorage();
    const runtime = createRecoverableRuntime();
    const agentTemplates = [
      {
        id: "remote-agent",
        name: "Remote agent",
        spawn: { command: "agent", args: [] },
        runtime: { provider: "e2b" },
      },
    ];
    const creator = new Flamecast({ storage, runtimes: { e2b: runtime }, agentTemplates });
    const session = await creator.createSession({
      agentTemplateId: "remote-agent",
      runtimeInstance: "e2b",
      webhooks: [],
    });

    const stateless = new Flamecast({ storage, runtimes: { e2b: runtime }, agentTemplates });

    try {
      const snapshot = await stateless.getSession(session.id);
      expect(snapshot.websocketUrl).toBe(`wss://runtime.example/${session.id}`);

      const result = await stateless.promptSession(
        session.id,
        "hello from recovered control plane",
      );
      expect(result).toEqual({ stopReason: "end_turn" });
      expect(runtime.reconnectCalls).toContain(session.id);
      expect(runtime.promptBodies).toContainEqual({
        sessionId: session.id,
        text: "hello from recovered control plane",
      });
    } finally {
      await stateless.close();
      await creator.shutdown();
    }
  });

  it("restores persisted webhooks and pending permission state after a cold start", async () => {
    const storage = await createTestStorage();
    const runtime = createRecoverableRuntime();
    const agentTemplates = [
      {
        id: "remote-agent",
        name: "Remote agent",
        spawn: { command: "agent", args: [] },
        runtime: { provider: "e2b" },
      },
    ];
    const creator = new Flamecast({ storage, runtimes: { e2b: runtime }, agentTemplates });
    const session = await creator.createSession({
      agentTemplateId: "remote-agent",
      runtimeInstance: "e2b",
      webhooks: [
        {
          url: "https://hooks.example/flamecast",
          secret: "shh",
          events: ["permission_request"],
        },
      ],
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    const stateless = new Flamecast({ storage, runtimes: { e2b: runtime }, agentTemplates });

    try {
      const callbackResult = await stateless.handleSessionEvent(session.id, {
        type: "permission_request",
        data: {
          requestId: "req-1",
          toolCallId: "tool-1",
          title: "Write file",
          kind: "file_write",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      expect(callbackResult).toEqual({ deferred: true });

      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

      const snapshot = await stateless.getSession(session.id);
      expect(snapshot.pendingPermission).toEqual({
        requestId: "req-1",
        toolCallId: "tool-1",
        title: "Write file",
        kind: "file_write",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      await stateless.resolvePermission(session.id, "req-1", { optionId: "allow" });

      const afterResolve = await stateless.getSession(session.id);
      expect(afterResolve.pendingPermission).toBeNull();
    } finally {
      await stateless.close();
      await creator.shutdown();
    }
  });
});
