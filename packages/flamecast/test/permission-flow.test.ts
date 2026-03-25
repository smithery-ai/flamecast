/**
 * Tier 1 Integration Test: Permission Flow
 *
 * Tests permission request round-trips through the full Flamecast stack
 * using InProcessSessionHost. Validates event shapes, approve/reject/cancel
 * flows, and onPermissionRequest handler wiring.
 */

/* oxlint-disable no-type-assertion/no-type-assertion */
import { describe, it, expect, vi } from "vitest";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
import type { Runtime } from "../src/flamecast/runtime.js";
import type { PermissionRequestContext } from "../src/flamecast/index.js";
import type { PermissionRequestEvent } from "../src/shared/session-host-protocol.js";
import { InProcessSessionHost } from "./fixtures/in-process-session-host.js";

// ===========================================================================
// 1. Permission event shape validation
// ===========================================================================

describe("permission event shape", () => {
  it("injected permission request matches PermissionRequestEvent shape", async () => {
    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // Inject a permission request into the running session
      const event = runtime.injectPermissionRequest(session.id, {
        requestId: "req-shape-test",
        toolCallId: "tool-shape-test",
        title: "Allow file write to /tmp/out.txt",
        kind: "file_write",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });

      // Validate the shape matches PermissionRequestEvent
      expect(event).toHaveProperty("requestId", "req-shape-test");
      expect(event).toHaveProperty("toolCallId", "tool-shape-test");
      expect(event).toHaveProperty("title", "Allow file write to /tmp/out.txt");
      expect(event).toHaveProperty("kind", "file_write");
      expect(event.options).toHaveLength(2);
      expect(event.options[0]).toEqual({ optionId: "allow", name: "Allow", kind: "allow_once" });
      expect(event.options[1]).toEqual({ optionId: "deny", name: "Deny", kind: "reject_once" });

      // Verify the event is recorded in the session's event stream
      const events = runtime.getEvents(session.id);
      const permEvents = events.filter((e) => e.type === "permission_request");
      expect(permEvents.length).toBeGreaterThanOrEqual(1);

      const lastPermEvent = permEvents[permEvents.length - 1].data as PermissionRequestEvent;
      expect(lastPermEvent.requestId).toBe("req-shape-test");
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 2. Approve flow
// ===========================================================================

describe("permission approve flow", () => {
  it("approve via handlePermissionRequest with c.allow()", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.allow();
    });

    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // Invoke the handler with a permission event
      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-approve",
        toolCallId: "tool-approve",
        title: "Allow file write",
        kind: "file_write",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });

      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
      expect(response).toEqual({ optionId: "allow" });

      // Verify the handler context
      const ctx = onPermissionRequest.mock.calls[0][0];
      expect(ctx.session.id).toBe(session.id);
      expect(ctx.session.agentName).toBe("echo hello");
      expect(ctx.requestId).toBe("req-approve");
      expect(ctx.toolCallId).toBe("tool-approve");
      expect(ctx.title).toBe("Allow file write");
      expect(ctx.kind).toBe("file_write");
      expect(ctx.options).toHaveLength(2);
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 3. Reject flow
// ===========================================================================

describe("permission reject flow", () => {
  it("reject via handlePermissionRequest with c.deny()", async () => {
    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      return c.deny();
    });

    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
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
        requestId: "req-reject",
        toolCallId: "tool-reject",
        title: "Run shell command: rm -rf /",
        kind: "command_execution",
        options: [
          { optionId: "yes", name: "Yes", kind: "allow_once" },
          { optionId: "no", name: "No", kind: "reject_once" },
        ],
      });

      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
      expect(response).toEqual({ optionId: "no" });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("reject flow - handler returns explicit optionId", async () => {
    const onPermissionRequest = vi.fn(async () => {
      return { optionId: "custom-reject" };
    });

    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
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
        requestId: "req-explicit",
        toolCallId: "tool-explicit",
        title: "Install package",
        kind: "package_install",
        options: [
          { optionId: "approve-all", name: "Approve All", kind: "allow_once" },
          { optionId: "custom-reject", name: "Custom Reject", kind: "reject_once" },
        ],
      });

      expect(response).toEqual({ optionId: "custom-reject" });
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 4. onPermissionRequest handler registration
// ===========================================================================

describe("onPermissionRequest handler", () => {
  it("handler is called when registered", async () => {
    const handlerCalls: Array<{
      requestId: string;
      title: string;
      sessionId: string;
    }> = [];

    const onPermissionRequest = vi.fn(async (c: PermissionRequestContext<{ local: Runtime }>) => {
      handlerCalls.push({
        requestId: c.requestId,
        title: c.title,
        sessionId: c.session.id,
      });
      return c.allow();
    });

    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
      onPermissionRequest,
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-handler",
        toolCallId: "tool-handler",
        title: "Allow network request",
        kind: "network",
        options: [{ optionId: "ok", name: "OK", kind: "allow_once" }],
      });

      expect(handlerCalls).toHaveLength(1);
      expect(handlerCalls[0].requestId).toBe("req-handler");
      expect(handlerCalls[0].title).toBe("Allow network request");
      expect(handlerCalls[0].sessionId).toBe(session.id);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("returning undefined defers (no handler registered)", async () => {
    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
    // No onPermissionRequest handler registered
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      const response = await flamecast.handlePermissionRequest(session.id, {
        requestId: "req-deferred",
        toolCallId: "tool-deferred",
        title: "Allow file write",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      // No handler => undefined => defers to WS
      expect(response).toBeUndefined();
    } finally {
      await flamecast.shutdown();
    }
  });

  it("handler returning undefined explicitly defers to WS", async () => {
    const onPermissionRequest = vi.fn(async () => {
      // Explicitly defer — let the WebSocket handle it
      return undefined;
    });

    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
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
        requestId: "req-ws-defer",
        toolCallId: "tool-ws-defer",
        title: "Allow file write",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      expect(onPermissionRequest).toHaveBeenCalledTimes(1);
      expect(response).toBeUndefined();
    } finally {
      await flamecast.shutdown();
    }
  });
});

// ===========================================================================
// 5. InProcessSessionHost permission lifecycle (runtime-level)
// ===========================================================================

describe("InProcessSessionHost permission management", () => {
  it("inject, list, and resolve permissions", async () => {
    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // Inject a permission
      const event = runtime.injectPermissionRequest(session.id, {
        requestId: "req-lifecycle",
        title: "Write to disk",
      });

      expect(event.requestId).toBe("req-lifecycle");

      // Should be pending
      const pending = runtime.getPendingPermissions(session.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].requestId).toBe("req-lifecycle");

      // Resolve it
      runtime.resolvePermission(session.id, "req-lifecycle", { optionId: "allow" });

      // Should no longer be pending
      expect(runtime.getPendingPermissions(session.id)).toHaveLength(0);

      // Verify events recorded
      const events = runtime.getEvents(session.id);
      const resolvedEvents = events.filter((e) => e.type === "permission_resolved");
      expect(resolvedEvents).toHaveLength(1);
    } finally {
      await flamecast.shutdown();
    }
  });

  it("cancel permission resolves with cancelled outcome", async () => {
    const runtime = new InProcessSessionHost();
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      runtime.injectPermissionRequest(session.id, {
        requestId: "req-cancel",
      });

      runtime.resolvePermission(session.id, "req-cancel", { outcome: "cancelled" });

      const events = runtime.getEvents(session.id);
      const resolved = events.filter((e) => e.type === "permission_resolved");
      expect(resolved).toHaveLength(1);

      const data = resolved[0].data as {
        requestId: string;
        response: { outcome: string };
      };
      expect(data.response).toEqual({ outcome: "cancelled" });
    } finally {
      await flamecast.shutdown();
    }
  });

  it("permissions auto-emitted with permissionBehavior config", async () => {
    const runtime = new InProcessSessionHost({ permissionBehavior: "approve" });
    const storage = new MemoryFlamecastStorage();
    const flamecast = new Flamecast({
      storage,
      runtimes: { local: runtime },
    });

    try {
      const session = await flamecast.createSession({
        spawn: { command: "echo", args: ["hello"] },
      });

      // With permissionBehavior: "approve", an initial permission request
      // should have been auto-emitted and auto-resolved on session start
      const events = runtime.getEvents(session.id);
      const permEvents = events.filter((e) => e.type === "permission_request");
      expect(permEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      await flamecast.shutdown();
    }
  });
});
