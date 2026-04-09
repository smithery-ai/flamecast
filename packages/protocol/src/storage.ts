import type { RuntimeInstance } from "./runtime.js";
import type { AgentTemplate, Session, WebhookConfig } from "./session.js";

/** Durable slice of {@link Session} (everything except runtime-only state). */
export type SessionMeta = Omit<Session, "fileSystem" | "logs" | "promptQueue">;

/** Runtime connection info persisted alongside a session for recovery after restart. */
export interface SessionRuntimeInfo {
  hostUrl: string;
  websocketUrl: string;
  runtimeName: string;
  runtimeMeta?: Record<string, unknown> | null;
}

/** Storage view of a session, including durable routing metadata. */
export interface StoredSession {
  meta: SessionMeta;
  runtimeInfo: SessionRuntimeInfo | null;
  webhooks: WebhookConfig[];
}

/**
 * Durable backing store for orchestrator state. Runtime (child process, ACP stream)
 * stays in memory; storage is the source of truth for metadata.
 */
export interface FlamecastStorage {
  /**
   * Synchronize the constructor-provided template set.
   * Managed templates are upserted and any previously managed templates that are
   * no longer present are pruned. User-registered templates are preserved.
   */
  seedAgentTemplates(templates: AgentTemplate[]): Promise<void>;
  listAgentTemplates(): Promise<AgentTemplate[]>;
  getAgentTemplate(id: string): Promise<AgentTemplate | null>;
  saveAgentTemplate(template: AgentTemplate): Promise<void>;
  updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): Promise<AgentTemplate | null>;
  createSession(
    meta: SessionMeta,
    runtimeInfo?: SessionRuntimeInfo,
    webhooks?: WebhookConfig[],
  ): Promise<void>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission" | "title">>,
  ): Promise<void>;
  getSessionMeta(id: string): Promise<SessionMeta | null>;
  getStoredSession(id: string): Promise<StoredSession | null>;
  /** Return all sessions (active + killed), ordered by lastUpdatedAt desc. */
  listAllSessions(): Promise<SessionMeta[]>;
  /** Return active sessions with their persisted runtime connection info for recovery. */
  listActiveSessionsWithRuntime(): Promise<StoredSession[]>;
  finalizeSession(id: string, reason: "terminated"): Promise<void>;

  // Runtime instance management
  saveRuntimeInstance(instance: RuntimeInstance): Promise<void>;
  listRuntimeInstances(): Promise<RuntimeInstance[]>;
  deleteRuntimeInstance(name: string): Promise<void>;
}
