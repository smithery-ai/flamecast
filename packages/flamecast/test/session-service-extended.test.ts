/**
 * Tier 1 Integration Test: SessionService Extended
 *
 * Extends the existing session-service tests with InProcessSessionHost.
 * Tests runtime dispatch, multi-runtime isolation, and event handler wiring.
 */

/* oxlint-disable no-type-assertion/no-type-assertion */
import { describe, it, expect, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { SessionService } from "../src/flamecast/session-service.js";
import { createTestStorage } from "./fixtures/test-helpers.js";
import type { Runtime } from "@flamecast/protocol/runtime";
import type { PermissionRequestContext, SessionEndContext } from "../src/flamecast/index.js";
import { InProcessSessionHost } from "./fixtures/in-process-session-host.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function defaultStartOpts(provider: string) {
  return {
    agentName: "test-agent",
    spawn: { command: "echo", args: ["hello"] },
    cwd: ".",
    runtime: { provider },
    startedAt: new Date().toISOString(),
  };
}

// ===========================================================================
// 1. Runtime dispatch with InProcessSessionHost
// ===========================================================================

describe("runtime dispatch with InProcessSessionHost", () => {
  it("dispatches to InProcessSessionHost and creates session", async () => {
    const runtime = new InProcessSessionHost();
    const service = new SessionService({ local: runtime });
    const storage = await createTestStorage();

    const { sessionId } = await service.startSession(storage, defaultStartOpts("local"));

    // Verify session exists in both service and runtime
    expect(service.hasSession(sessionId)).toBe(true);
    expect(runtime.getSessionIds()).toContain(sessionId);

    // Verify the session in the runtime has correct command
    const internalSession = runtime.getSession(sessionId);
    expect(internalSession).toBeDefined();
    expect(internalSession!.command).toBe("echo");
    expect(internalSession!.args).toEqual(["hello"]);
    expect(internalSession!.status).toBe("running");

    // Verify storage was updated
    const meta = await storage.getSessionMeta(sessionId);
    expect(meta).toBeDefined();
    expect(meta!.status).toBe("active");
    expect(meta!.agentName).toBe("test-agent");
  });

  it("terminate cleans up both service and runtime", async () => {
    const runtime = new InProcessSessionHost();
    const service = new SessionService({ local: runtime });
    const storage = await createTestStorage();

    const { sessionId } = await service.startSession(storage, defaultStartOpts("local"));
    expect(runtime.getSessionIds()).toContain(sessionId);

    await service.terminateSession(storage, sessionId);

    expect(service.hasSession(sessionId)).toBe(false);
    expect(runtime.getSessionIds()).not.toContain(sessionId);

    // Storage should show killed
    const meta = await storage.getSessionMeta(sessionId);
    expect(meta!.status).toBe("killed");
  });

  it("websocket URL is returned from InProcessSessionHost", async () => {
    const runtime = new InProcessSessionHost();
    const service = new SessionService({ local: runtime });
    const storage = await createTestStorage();

    const { sessionId } = await service.startSession(storage, defaultStartOpts("local"));

    const wsUrl = service.getWebsocketUrl(sessionId);
    expect(wsUrl).toBeTruthy();
    expect(wsUrl).toContain(sessionId);
    expect(wsUrl).toMatch(/^ws:\/\//);
  });
});

// ===========================================================================
// 2. Multiple runtimes — isolation
// ===========================================================================

describe("multiple runtimes isolation", () => {
  it("sessions on different runtimes are isolated", async () => {
    const runtimeA = new InProcessSessionHost({ responseText: "I am runtime A" });
    const runtimeB = new InProcessSessionHost({ responseText: "I am runtime B" });
    const service = new SessionService({ alpha: runtimeA, beta: runtimeB });
    const storage = await createTestStorage();

    const { sessionId: idA } = await service.startSession(storage, defaultStartOpts("alpha"));
    const { sessionId: idB } = await service.startSession(storage, defaultStartOpts("beta"));

    // Each runtime only has its own session
    expect(runtimeA.getSessionIds()).toContain(idA);
    expect(runtimeA.getSessionIds()).not.toContain(idB);
    expect(runtimeB.getSessionIds()).toContain(idB);
    expect(runtimeB.getSessionIds()).not.toContain(idA);

    // Service tracks both
    expect(service.hasSession(idA)).toBe(true);
    expect(service.hasSession(idB)).toBe(true);
    expect(service.listSessionIds()).toHaveLength(2);

    // getRuntimeName returns the correct provider
    expect(service.getRuntimeName(idA)).toBe("alpha");
    expect(service.getRuntimeName(idB)).toBe("beta");

    // Terminate one doesn't affect the other
    await service.terminateSession(storage, idA);
    expect(runtimeA.getSessionIds()).not.toContain(idA);
    expect(runtimeB.getSessionIds()).toContain(idB);
    expect(service.hasSession(idB)).toBe(true);
  });

  it("Flamecast with multiple runtimes routes by template provider", async () => {
    const runtimeLocal = new InProcessSessionHost();
    const runtimeCloud = new InProcessSessionHost();
    const storage = await createTestStorage();

    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtimeLocal, cloud: runtimeCloud },
      agentTemplates: [
        {
          id: "local-agent",
          name: "Local Agent",
          spawn: { command: "node", args: ["local.js"] },
          runtime: { provider: "local" },
        },
        {
          id: "cloud-agent",
          name: "Cloud Agent",
          spawn: { command: "node", args: ["cloud.js"] },
          runtime: { provider: "cloud" },
        },
      ],
    });

    try {
      const localSession = await flamecast.createSession({ agentTemplateId: "local-agent" });
      const cloudSession = await flamecast.createSession({ agentTemplateId: "cloud-agent" });

      // Verify each went to the correct runtime
      expect(runtimeLocal.getSessionIds()).toContain(localSession.id);
      expect(runtimeLocal.getSessionIds()).not.toContain(cloudSession.id);
      expect(runtimeCloud.getSessionIds()).toContain(cloudSession.id);
      expect(runtimeCloud.getSessionIds()).not.toContain(localSession.id);

      // Verify session metadata
      expect(localSession.agentName).toBe("Local Agent");
      expect(cloudSession.agentName).toBe("Cloud Agent");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("unknown runtime provider throws with available list", async () => {
    const runtimeA = new InProcessSessionHost();
    const runtimeB = new InProcessSessionHost();
    const service = new SessionService({ alpha: runtimeA, beta: runtimeB });
    const storage = await createTestStorage();

    await expect(service.startSession(storage, defaultStartOpts("nonexistent"))).rejects.toThrow(
      /Unknown runtime: "nonexistent"/,
    );

    await expect(service.startSession(storage, defaultStartOpts("nonexistent"))).rejects.toThrow(
      /Available: alpha, beta/,
    );
  });
});

// ===========================================================================
// 3. Event handler wiring — onSessionEnd
// ===========================================================================

describe("onSessionEnd fires on terminate with correct context", () => {
  it("onSessionEnd receives session context and reason", async () => {
    const endCalls: Array<{
      sessionId: string;
      agentName: string;
      reason: string;
      runtime: string;
    }> = [];

    const onSessionEnd = vi.fn(async (c: SessionEndContext<{ local: Runtime }>) => {
      endCalls.push({
        sessionId: c.session.id,
        agentName: c.session.agentName,
        reason: c.reason,
        runtime: c.session.runtime,
      });
    });

    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onSessionEnd,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "node", args: ["agent.js"] },
      });

      await flamecast.terminateSession(session.id);

      expect(onSessionEnd).toHaveBeenCalledTimes(1);
      expect(endCalls).toHaveLength(1);
      expect(endCalls[0].sessionId).toBe(session.id);
      expect(endCalls[0].agentName).toBe("node agent.js");
      expect(endCalls[0].reason).toBe("terminated");
      expect(endCalls[0].runtime).toBe("local");
    } finally {
      await flamecast.shutdown();
    }
  });

  it("onSessionEnd fires for each terminated session", async () => {
    const onSessionEnd = vi.fn(async () => {});

    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onSessionEnd,
    });

    try {
      const s1 = await flamecast.createSession({
        spawn: { command: "echo", args: ["one"] },
      });
      const s2 = await flamecast.createSession({
        spawn: { command: "echo", args: ["two"] },
      });

      await flamecast.terminateSession(s1.id);
      await flamecast.terminateSession(s2.id);

      expect(onSessionEnd).toHaveBeenCalledTimes(2);

      const ids = onSessionEnd.mock.calls.map(
        (call: [SessionEndContext<{ local: Runtime }>]) => call[0].session.id,
      );
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 4. onPermissionRequest fires with correct context and c.allow() resolves
// ===========================================================================

describe("onPermissionRequest with InProcessSessionHost context", () => {
  it("c.allow() resolves with first approve option", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      // Verify context fields are correctly populated
      expect(c.session.id).toBeTruthy();
      expect(c.session.agentName).toBe("echo hello");
      expect(c.session.runtime).toBe("local");
      expect(c.session.spawn).toEqual({ command: "echo", args: ["hello"] });
      expect(c.session.startedAt).toBeTruthy();

      return c.allow();
    });

    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-ctx",
        toolCallId: "tool-ctx",
        title: "Write file",
        kind: "file_write",
        options: [
          { optionId: "allow-it", name: "Allow", kind: "allow_once" },
          { optionId: "deny-it", name: "Deny", kind: "reject_once" },
        ],
      });

      expect(response).toEqual({ optionId: "allow-it" });
      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("c.deny() resolves with first reject option", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) =>
      c.deny(),
    );

    const runtime = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-deny",
        toolCallId: "tool-deny",
        title: "Delete file",
        kind: "file_delete",
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

  it("permission request on multi-runtime Flamecast routes to correct session", async () => {
    const permCalls: string[] = [];

    const onPermissionRequest = vi.fn(
      async (c: PermissionRequestContext<{ local: Runtime; cloud: Runtime }>) => {
        permCalls.push(`${c.session.runtime}:${c.session.id}`);
        return c.allow();
      },
    );

    const runtimeLocal = new InProcessSessionHost();
    const runtimeCloud = new InProcessSessionHost();
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtimeLocal, cloud: runtimeCloud },
      agentTemplates: [
        {
          id: "local-tmpl",
          name: "Local",
          spawn: { command: "echo", args: ["local"] },
          runtime: { provider: "local" },
        },
        {
          id: "cloud-tmpl",
          name: "Cloud",
          spawn: { command: "echo", args: ["cloud"] },
          runtime: { provider: "cloud" },
        },
      ],
      onPermissionRequest,
    });

    try {
      const localSession = await flamecast.createSession({ agentTemplateId: "local-tmpl" });
      const cloudSession = await flamecast.createSession({ agentTemplateId: "cloud-tmpl" });

      await flamecast.handlePermissionRequest(localSession.id, {
        requestId: "req-local",
        toolCallId: "tool-local",
        title: "Local permission",
        options: [{ optionId: "ok", name: "OK", kind: "allow_once" }],
      });

      await flamecast.handlePermissionRequest(cloudSession.id, {
        requestId: "req-cloud",
        toolCallId: "tool-cloud",
        title: "Cloud permission",
        options: [{ optionId: "ok", name: "OK", kind: "allow_once" }],
      });

      expect(onPermissionRequest).toHaveBeenCalledTimes(2);
      expect(permCalls).toContain(`local:${localSession.id}`);
      expect(permCalls).toContain(`cloud:${cloudSession.id}`);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 5. InProcessSessionHost filesystem snapshot
// ===========================================================================

describe("InProcessSessionHost filesystem events", () => {
  it("emits filesystem snapshot when configured", async () => {
    const runtime = new InProcessSessionHost({
      emitFilesystemSnapshot: true,
      filesystemEntries: [
        { path: "src/main.ts", type: "file" },
        { path: "README.md", type: "file" },
        { path: "dist", type: "directory" },
      ],
    });
    const storage = await createTestStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const events = runtime.getEvents(session.id);
      const fsEvents = events.filter((e) => e.type === "filesystem_snapshot");
      expect(fsEvents).toHaveLength(1);

      const snapshot = (fsEvents[0].data as { snapshot: { root: string; entries: unknown[] } })
        .snapshot;
      expect(snapshot.entries).toHaveLength(3);
      expect(snapshot.entries).toEqual([
        { path: "src/main.ts", type: "file" },
        { path: "README.md", type: "file" },
        { path: "dist", type: "directory" },
      ]);
    } finally {
      await flamecast.shutdown();
    }
  });
});
