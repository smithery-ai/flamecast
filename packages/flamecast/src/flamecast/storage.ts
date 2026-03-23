import type { AgentTemplate, Session, SessionLog } from "../shared/session.js";
import { MemoryFlamecastStorage } from "./storage/memory/index.js";

/** Durable slice of {@link Session} (everything except runtime-only state). */
export type SessionMeta = Omit<Session, "fileSystem" | "logs" | "promptQueue">;

/**
 * Durable backing store for orchestrator state. Runtime (child process, ACP stream)
 * stays in memory; storage is the source of truth for metadata and logs.
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
  createSession(meta: SessionMeta): Promise<void>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void>;
  appendLog(sessionId: string, log: SessionLog): Promise<void>;
  getSessionMeta(id: string): Promise<SessionMeta | null>;
  getLogs(sessionId: string): Promise<SessionLog[]>;
  /** Return all sessions (active + killed), ordered by lastUpdatedAt desc. */
  listAllSessions(): Promise<SessionMeta[]>;
  /** Called after the last termination log is appended — e.g. mark row dead (SQL) or evict (memory). */
  finalizeSession(id: string, reason: "terminated"): Promise<void>;
};

export function resolveStorage(storage?: FlamecastStorage): FlamecastStorage {
  if (!storage) {
    return new MemoryFlamecastStorage();
  }
  return storage;
}
