import type { SessionLog } from "../../../shared/session.js";
import type { AgentMeta, FlamecastStorage, SessionMeta } from "../../storage.js";

function cloneAgent(agent: AgentMeta): AgentMeta {
  return {
    ...agent,
    spawn: {
      command: agent.spawn.command,
      args: [...agent.spawn.args],
    },
    runtime: { ...agent.runtime },
  };
}

function cloneSession(session: SessionMeta): SessionMeta {
  return {
    ...session,
    spawn: {
      command: session.spawn.command,
      args: [...session.spawn.args],
    },
    pendingPermission: session.pendingPermission
      ? {
          ...session.pendingPermission,
          options: session.pendingPermission.options.map((option) => ({ ...option })),
        }
      : null,
  };
}

export class MemoryFlamecastStorage implements FlamecastStorage {
  private agents = new Map<string, AgentMeta>();
  private sessions = new Map<string, SessionMeta>();
  private logs = new Map<string, SessionLog[]>();

  async listAgents(): Promise<AgentMeta[]> {
    return [...this.agents.values()]
      .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt) || a.id.localeCompare(b.id))
      .map(cloneAgent);
  }

  async getAgent(id: string): Promise<AgentMeta | null> {
    const row = this.agents.get(id);
    return row ? cloneAgent(row) : null;
  }

  async createAgent(meta: AgentMeta): Promise<void> {
    this.agents.set(meta.id, cloneAgent(meta));
  }

  async updateAgent(
    id: string,
    patch: Partial<Pick<AgentMeta, "lastUpdatedAt" | "latestSessionId" | "sessionCount">>,
  ): Promise<void> {
    const row = this.agents.get(id);
    if (!row) throw new Error(`Agent "${id}" not found in storage`);
    this.agents.set(id, {
      ...row,
      ...patch,
    });
  }

  async createSession(meta: SessionMeta): Promise<void> {
    this.sessions.set(meta.id, cloneSession(meta));
    this.logs.set(meta.id, []);
  }

  async listSessionsByAgent(agentId: string): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .filter((session) => session.agentId === agentId)
      .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt) || a.id.localeCompare(b.id))
      .map(cloneSession);
  }

  async getSessionMeta(id: string): Promise<SessionMeta | null> {
    const row = this.sessions.get(id);
    return row ? cloneSession(row) : null;
  }

  async updateSession(
    id: string,
    patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void> {
    const row = this.sessions.get(id);
    if (!row) throw new Error(`Session "${id}" not found in storage`);
    this.sessions.set(id, {
      ...row,
      ...patch,
      pendingPermission:
        patch.pendingPermission !== undefined ? patch.pendingPermission : row.pendingPermission,
    });
  }

  async appendLog(sessionId: string, log: SessionLog): Promise<void> {
    const list = this.logs.get(sessionId);
    if (!list) throw new Error(`Session "${sessionId}" has no log stream`);
    list.push(log);
  }

  async getLogs(sessionId: string): Promise<SessionLog[]> {
    return [...(this.logs.get(sessionId) ?? [])];
  }

  async finalizeSession(id: string, _reason: "terminated"): Promise<void> {
    this.sessions.delete(id);
    this.logs.delete(id);
  }

  async finalizeAgent(id: string, _reason: "terminated"): Promise<void> {
    this.agents.delete(id);

    for (const [sessionId, session] of this.sessions) {
      if (session.agentId === id) {
        this.sessions.delete(sessionId);
        this.logs.delete(sessionId);
      }
    }
  }
}
