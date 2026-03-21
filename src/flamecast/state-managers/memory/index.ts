import type { SessionLog } from "../../../shared/session.js";
import type { FlamecastStorage, SessionMeta } from "../../storage.js";

/** In-memory storage (tests / local tools) */
export class MemoryFlamecastStorage implements FlamecastStorage {
  private sessions = new Map<string, SessionMeta>();
  private logs = new Map<string, SessionLog[]>();

  async createSession(meta: SessionMeta): Promise<void> {
    this.sessions.set(meta.id, { ...meta });
    this.logs.set(meta.id, []);
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

  async getSessionMeta(id: string): Promise<SessionMeta | null> {
    const row = this.sessions.get(id);
    return row ? { ...row } : null;
  }

  async getLogs(sessionId: string): Promise<SessionLog[]> {
    return [...(this.logs.get(sessionId) ?? [])];
  }

  async finalizeSession(id: string, _reason: "terminated"): Promise<void> {
    this.sessions.delete(id);
    this.logs.delete(id);
  }
}
