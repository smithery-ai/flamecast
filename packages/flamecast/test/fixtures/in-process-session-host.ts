/**
 * InProcessSessionHost — a Runtime implementation that simulates a session host
 * with a fake ACP agent entirely in-memory. No child processes, no Docker, no ports.
 *
 * This is NOT a mock that returns hardcoded values. It parses the same request
 * shapes and returns the same response shapes as the real session host, so tests
 * catch contract drift.
 */

import type { Runtime } from "@flamecast/protocol/runtime";
import type {
  SessionHostStartRequest,
  SessionHostStartResponse,
  PermissionRequestEvent,
  FilesystemSnapshotEvent,
} from "@flamecast/protocol/session-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PermissionBehavior = "approve" | "reject" | "cancel" | "none";

interface FakeAgentConfig {
  /** Canned text the agent responds with when prompted. */
  responseText?: string;
  /** How to handle permission requests: emit one and auto-resolve, or skip. */
  permissionBehavior?: PermissionBehavior;
  /** If true, emit a filesystem snapshot after start. */
  emitFilesystemSnapshot?: boolean;
  /** Custom filesystem entries for the snapshot. */
  filesystemEntries?: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }>;
}

interface ManagedSession {
  id: string;
  command: string;
  args: string[];
  workspace: string;
  status: "idle" | "running";
  /** Events emitted by the fake agent, consumable by tests. */
  events: Array<{ type: string; data: unknown }>;
  /** Pending permission requests waiting for a response. */
  pendingPermissions: Map<string, PermissionRequestEvent>;
  /** Resolved permission responses. */
  resolvedPermissions: Map<string, { optionId: string } | { outcome: "cancelled" }>;
  /** Promise resolvers for permission responses. */
  permissionResolvers: Map<
    string,
    (value: { optionId: string } | { outcome: "cancelled" }) => void
  >;
}

// ---------------------------------------------------------------------------
// InProcessSessionHost
// ---------------------------------------------------------------------------

export class InProcessSessionHost implements Runtime {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly agentConfig: FakeAgentConfig;
  private nextRequestId = 1;

  constructor(config: FakeAgentConfig = {}) {
    this.agentConfig = {
      responseText: config.responseText ?? "I am a fake ACP agent. How can I help?",
      permissionBehavior: config.permissionBehavior ?? "none",
      emitFilesystemSnapshot: config.emitFilesystemSnapshot ?? false,
      filesystemEntries: config.filesystemEntries,
    };
  }

  // -------------------------------------------------------------------------
  // Runtime interface
  // -------------------------------------------------------------------------

  async autoStart(): Promise<void> {
    throw new Error("InProcessSessionHost does not support auto-start");
  }

  async fetchSession(sessionId: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /start
    if (path.endsWith("/start") && request.method === "POST") {
      return this.handleStart(sessionId, request);
    }

    // POST /terminate
    if (path.endsWith("/terminate") && request.method === "POST") {
      return this.handleTerminate(sessionId);
    }

    // GET /health
    if (path.endsWith("/health") && request.method === "GET") {
      return this.handleHealth(sessionId);
    }

    // POST /prompt — simulate sending a prompt to the agent
    if (path.endsWith("/prompt") && request.method === "POST") {
      return this.handlePrompt(sessionId, request);
    }

    // POST /permission/respond — resolve a pending permission
    if (path.endsWith("/permission/respond") && request.method === "POST") {
      return this.handlePermissionRespond(sessionId, request);
    }

    // Unknown route
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.jsonResponse({ error: "Session not found" }, 404);
    }

    return this.jsonResponse({ error: `Unknown route: ${request.method} ${path}` }, 404);
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Test inspection API — NOT part of the Runtime interface
  // -------------------------------------------------------------------------

  /** Get the managed session for test inspection. */
  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get all session IDs. */
  getSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Get events emitted by a session. */
  getEvents(sessionId: string): Array<{ type: string; data: unknown }> {
    return this.sessions.get(sessionId)?.events ?? [];
  }

  /** Get pending permission requests for a session. */
  getPendingPermissions(sessionId: string): PermissionRequestEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return [...session.pendingPermissions.values()];
  }

  /**
   * Manually inject a permission request event into a session.
   * Returns the requestId so tests can respond to it.
   */
  injectPermissionRequest(
    sessionId: string,
    overrides: Partial<PermissionRequestEvent> = {},
  ): PermissionRequestEvent {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found in InProcessSessionHost`);

    const requestId = overrides.requestId ?? `req-${this.nextRequestId++}`;
    const event: PermissionRequestEvent = {
      requestId,
      toolCallId: overrides.toolCallId ?? `tool-${requestId}`,
      title: overrides.title ?? "Allow file write to /tmp/test.txt",
      kind: overrides.kind ?? "file_write",
      options: overrides.options ?? [
        { optionId: "allow", name: "Allow", kind: "approve" },
        { optionId: "deny", name: "Deny", kind: "reject" },
      ],
    };

    session.pendingPermissions.set(requestId, event);
    session.events.push({ type: "permission_request", data: event });

    return event;
  }

  /**
   * Resolve a pending permission request (simulates the control plane responding).
   */
  resolvePermission(
    sessionId: string,
    requestId: string,
    response: { optionId: string } | { outcome: "cancelled" },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`No pending permission "${requestId}" in session "${sessionId}"`);

    session.pendingPermissions.delete(requestId);
    session.resolvedPermissions.set(requestId, response);

    // Resolve any waiters
    const resolver = session.permissionResolvers.get(requestId);
    if (resolver) {
      resolver(response);
      session.permissionResolvers.delete(requestId);
    }

    session.events.push({ type: "permission_resolved", data: { requestId, response } });
  }

  /**
   * Wait for a permission request to be resolved (or timeout).
   */
  waitForPermissionResolution(
    sessionId: string,
    requestId: string,
    timeoutMs = 5000,
  ): Promise<{ optionId: string } | { outcome: "cancelled" }> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`Session "${sessionId}" not found`));

    // Already resolved?
    const resolved = session.resolvedPermissions.get(requestId);
    if (resolved) return Promise.resolve(resolved);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.permissionResolvers.delete(requestId);
        reject(new Error(`Permission "${requestId}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      session.permissionResolvers.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Route handlers
  // -------------------------------------------------------------------------

  private async handleStart(sessionId: string, request: Request): Promise<Response> {
    if (this.sessions.has(sessionId)) {
      return this.jsonResponse({ error: `Session "${sessionId}" already exists` }, 409);
    }

    let body: SessionHostStartRequest;
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (!body.command || typeof body.command !== "string") {
      return this.jsonResponse({ error: "Missing or invalid 'command' field" }, 400);
    }

    const session: ManagedSession = {
      id: sessionId,
      command: body.command,
      args: body.args ?? [],
      workspace: body.workspace ?? ".",
      status: "running",
      events: [],
      pendingPermissions: new Map(),
      resolvedPermissions: new Map(),
      permissionResolvers: new Map(),
    };

    this.sessions.set(sessionId, session);

    // The hostUrl/websocketUrl point to a fake in-process address.
    // They are never actually connected to — the Runtime interface routes
    // all traffic through fetchSession().
    const hostUrl = `http://in-process/${sessionId}`;
    const websocketUrl = `ws://in-process/${sessionId}/ws`;

    const result: SessionHostStartResponse = {
      acpSessionId: sessionId,
      hostUrl,
      websocketUrl,
    };

    session.events.push({ type: "session_started", data: { sessionId } });

    // Emit filesystem snapshot if configured
    if (this.agentConfig.emitFilesystemSnapshot) {
      const snapshot: FilesystemSnapshotEvent = {
        snapshot: {
          root: body.workspace ?? "/workspace",
          entries: this.agentConfig.filesystemEntries ?? [
            { path: "src/index.ts", type: "file" },
            { path: "package.json", type: "file" },
            { path: "node_modules", type: "directory" },
          ],
        },
      };
      session.events.push({ type: "filesystem_snapshot", data: snapshot });
    }

    // If configured, emit an initial permission request
    if (this.agentConfig.permissionBehavior !== "none") {
      this.injectPermissionRequest(sessionId);
    }

    return this.jsonResponse(result, 200);
  }

  private handleTerminate(sessionId: string): Response {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    session.status = "idle";
    session.events.push({ type: "session_terminated", data: { sessionId } });

    // Clean up pending permissions
    for (const [, resolver] of session.permissionResolvers) {
      resolver({ outcome: "cancelled" });
    }
    session.permissionResolvers.clear();
    session.pendingPermissions.clear();

    this.sessions.delete(sessionId);

    return this.jsonResponse({ ok: true }, 200);
  }

  private handleHealth(sessionId: string): Response {
    const session = this.sessions.get(sessionId);
    const status = session ? session.status : "idle";
    return this.jsonResponse({ status }, 200);
  }

  private async handlePrompt(sessionId: string, request: Request): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    let body: { text: string };
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    session.events.push({ type: "prompt_received", data: { text: body.text } });

    // Simulate agent response
    session.events.push({
      type: "agent_response",
      data: { text: this.agentConfig.responseText },
    });

    // If permission behavior is configured, emit a permission request for this prompt
    if (this.agentConfig.permissionBehavior !== "none") {
      const permEvent = this.injectPermissionRequest(sessionId, {
        title: `Permission for prompt: "${body.text}"`,
      });

      // Auto-resolve based on configured behavior
      if (this.agentConfig.permissionBehavior === "approve") {
        const approveOpt = permEvent.options.find((o) => o.kind === "approve");
        if (approveOpt) {
          this.resolvePermission(sessionId, permEvent.requestId, { optionId: approveOpt.optionId });
        }
      } else if (this.agentConfig.permissionBehavior === "reject") {
        const rejectOpt = permEvent.options.find((o) => o.kind === "reject");
        if (rejectOpt) {
          this.resolvePermission(sessionId, permEvent.requestId, { optionId: rejectOpt.optionId });
        }
      } else if (this.agentConfig.permissionBehavior === "cancel") {
        this.resolvePermission(sessionId, permEvent.requestId, { outcome: "cancelled" });
      }
    }

    return this.jsonResponse({
      text: this.agentConfig.responseText,
      status: "completed",
    });
  }

  private async handlePermissionRespond(sessionId: string, request: Request): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.jsonResponse({ error: `Session "${sessionId}" not found` }, 404);
    }

    let body: { requestId: string; response: { optionId: string } | { outcome: "cancelled" } };
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const pending = session.pendingPermissions.get(body.requestId);
    if (!pending) {
      return this.jsonResponse({ error: `No pending permission "${body.requestId}"` }, 404);
    }

    this.resolvePermission(sessionId, body.requestId, body.response);

    return this.jsonResponse({ ok: true });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
