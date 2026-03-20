import { randomUUID } from "node:crypto";
import type { ConnectionLog } from "../../../shared/connection.js";
import type { ConnectionMeta, FlamecastProjection } from "../../projection.js";

/** In-memory projection (tests / local tools) */
export class MemoryFlamecastProjection implements FlamecastProjection {
  private connections = new Map<string, ConnectionMeta>();
  private logs = new Map<string, ConnectionLog[]>();

  async allocateConnectionId(): Promise<string> {
    return randomUUID();
  }

  async createConnection(meta: ConnectionMeta): Promise<void> {
    this.connections.set(meta.id, { ...meta });
    this.logs.set(meta.id, []);
  }

  async updateConnection(
    id: string,
    patch: Partial<Pick<ConnectionMeta, "sessionId" | "lastUpdatedAt" | "pendingPermission">>,
  ): Promise<void> {
    const row = this.connections.get(id);
    if (!row) throw new Error(`Connection "${id}" not found in projection`);
    this.connections.set(id, {
      ...row,
      ...patch,
      pendingPermission:
        patch.pendingPermission !== undefined ? patch.pendingPermission : row.pendingPermission,
    });
  }

  async appendLog(connectionId: string, _sessionId: string, log: ConnectionLog): Promise<void> {
    const list = this.logs.get(connectionId);
    if (!list) throw new Error(`Connection "${connectionId}" has no log stream`);
    list.push(log);
  }

  async getConnectionMeta(id: string): Promise<ConnectionMeta | null> {
    const row = this.connections.get(id);
    return row ? { ...row } : null;
  }

  async getLogs(connectionId: string): Promise<ConnectionLog[]> {
    return [...(this.logs.get(connectionId) ?? [])];
  }

  async finalizeConnection(id: string, _reason: "killed"): Promise<void> {
    this.connections.delete(id);
    this.logs.delete(id);
  }
}
