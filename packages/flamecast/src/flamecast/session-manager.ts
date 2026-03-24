import type { AgentSpawn, AgentTemplateRuntime } from "../shared/session.js";
import type { FlamecastStorage } from "./storage.js";
import type { DataPlaneBinding, BridgeStartRequest, BridgeStartResponse } from "./data-plane.js";

interface ManagedSession {
  id: string;
  websocketUrl: string;
}

/**
 * SessionManager — control plane code that provisions data plane instances.
 *
 * Uses the DataPlaneBinding interface to talk to runtime-bridge processes.
 * Storage is passed per-call (not held in constructor) to avoid Workers
 * I/O context issues — each request must use its own storage connection.
 */
export class SessionManager {
  private readonly binding: DataPlaneBinding;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(binding: DataPlaneBinding) {
    this.binding = binding;
  }

  async startSession(
    storage: FlamecastStorage,
    opts: {
      agentName: string;
      spawn: AgentSpawn;
      cwd: string;
      runtime: AgentTemplateRuntime;
      startedAt: string;
    },
  ): Promise<{ sessionId: string }> {
    const sessionId = crypto.randomUUID();

    const body: BridgeStartRequest = {
      command: opts.spawn.command,
      args: opts.spawn.args ?? [],
      workspace: opts.cwd,
      setup: opts.runtime.setup,
    };

    const response = await this.binding.fetchSession(
      sessionId,
      new Request("http://bridge/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bridge /start failed: ${error}`);
    }

    const result: BridgeStartResponse = await response.json();

    const session: ManagedSession = {
      id: sessionId, // Use control-plane UUID, not ACP session ID — router maps by this ID
      websocketUrl: result.websocketUrl,
    };

    await storage.createSession({
      id: sessionId,
      agentName: opts.agentName,
      spawn: opts.spawn,
      startedAt: opts.startedAt,
      lastUpdatedAt: new Date().toISOString(),
      status: "active",
      pendingPermission: null,
    });

    this.sessions.set(session.id, session);
    return { sessionId: session.id };
  }

  async terminateSession(storage: FlamecastStorage, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    await this.binding.fetchSession(
      sessionId,
      new Request("http://bridge/terminate", { method: "POST" }),
    );

    await storage.finalizeSession(sessionId, "terminated");
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  getWebsocketUrl(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.websocketUrl;
  }
}
