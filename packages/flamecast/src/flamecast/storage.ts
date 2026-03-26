import type { AgentTemplate, Session } from "../shared/session.js";

/** Durable slice of {@link Session} (everything except runtime-only state). */
export type SessionMeta = Omit<Session, "fileSystem" | "logs" | "promptQueue">;

/** Runtime connection info persisted alongside a session for recovery after restart. */
export interface SessionRuntimeInfo {
  hostUrl: string;
  websocketUrl: string;
  runtimeName: string;
  runtimeMeta?: Record<string, unknown> | null;
}

/**
 * Durable backing store for orchestrator state. Runtime (child process, ACP stream)
 * stays in memory; storage is the source of truth for metadata.
 */
export type FlamecastStorage = {
  /**
   * Synchronize the constructor-provided template set.
   * Managed templates are upserted and any previously managed templates that are
   * no longer present are pruned. User-registered templates are preserved.
   */
  seedAgentTemplates(templates: AgentTemplate[]): Promise<void>;
  listAgentTemplates(): Promise<AgentTemplate[]>;
  getAgentTemplate(id: string): Promise<AgentTemplate | null>;
  saveAgentTemplate(template: AgentTemplate): Promise<void>;
  createSession(meta: SessionMeta, runtimeInfo?: SessionRuntimeInfo): Promise<void>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void>;
  getSessionMeta(id: string): Promise<SessionMeta | null>;
  /** Return all sessions (active + killed), ordered by lastUpdatedAt desc. */
  listAllSessions(): Promise<SessionMeta[]>;
  /** Return active sessions with their persisted runtime connection info for recovery. */
  listActiveSessionsWithRuntime(): Promise<
    Array<SessionMeta & { runtimeInfo: SessionRuntimeInfo | null }>
  >;
  finalizeSession(id: string, reason: "terminated"): Promise<void>;
};
