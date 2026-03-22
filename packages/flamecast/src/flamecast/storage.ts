import type { Agent, AgentTemplate, Session, SessionLog } from "../shared/session.js";

/** Durable slice of {@link Agent} used by storage-backed runtime metadata. */
export type AgentMeta = Agent;

/** Durable slice of {@link Session} (everything except `logs` and `fileSystem`). */
export type SessionMeta = Omit<Session, "logs" | "fileSystem">;

/**
 * Durable backing store for orchestrator state. Runtime (child process, ACP stream)
 * stays in memory; storage is the source of truth for metadata and logs.
 */
export type FlamecastStorage = {
  listAgents(): Promise<AgentMeta[]>;
  getAgent(id: string): Promise<AgentMeta | null>;
  createAgent(meta: AgentMeta): Promise<void>;
  updateAgent(
    id: string,
    patch: Partial<Pick<AgentMeta, "lastUpdatedAt" | "latestSessionId" | "sessionCount">>,
  ): Promise<void>;
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
  listSessionsByAgent(agentId: string): Promise<SessionMeta[]>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void>;
  appendLog(sessionId: string, log: SessionLog): Promise<void>;
  getSessionMeta(id: string): Promise<SessionMeta | null>;
  getLogs(sessionId: string): Promise<SessionLog[]>;
  /** Called after the last termination log is appended — e.g. mark row dead (SQL) or evict (memory). */
  finalizeSession(id: string, reason: "terminated"): Promise<void>;
  finalizeAgent(id: string, reason: "terminated"): Promise<void>;
};

export type StorageConfig =
  | "memory"
  | "pglite"
  | { type: "memory" }
  | { type: "pglite"; dataDir?: string }
  | { type: "postgres"; url: string }
  | FlamecastStorage;

export async function resolveStorage(config?: StorageConfig): Promise<FlamecastStorage> {
  if (!config || config === "pglite") {
    const { createDatabase } = await import("./db/client.js");
    const { db } = await createDatabase();
    const { createPsqlStorage } = await import("./state-managers/psql/index.js");
    return createPsqlStorage(db);
  }

  if (config === "memory") {
    const { MemoryFlamecastStorage } = await import("./state-managers/memory/index.js");
    return new MemoryFlamecastStorage();
  }

  if (typeof config === "object" && "type" in config) {
    switch (config.type) {
      case "memory": {
        const { MemoryFlamecastStorage } = await import("./state-managers/memory/index.js");
        return new MemoryFlamecastStorage();
      }
      case "pglite": {
        const { createDatabase } = await import("./db/client.js");
        const { db } = await createDatabase({ pgliteDataDir: config.dataDir });
        const { createPsqlStorage } = await import("./state-managers/psql/index.js");
        return createPsqlStorage(db);
      }
      case "postgres": {
        const { createDatabase } = await import("./db/client.js");
        process.env.FLAMECAST_POSTGRES_URL = config.url;
        const { db } = await createDatabase();
        const { createPsqlStorage } = await import("./state-managers/psql/index.js");
        return createPsqlStorage(db);
      }
    }
  }

  return config;
}
