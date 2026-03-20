import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { ConnectionLog } from "../../../shared/connection.js";
import type { ConnectionMeta, FlamecastStateManager } from "../../state-manager.js";
import { connectionLogs, connections } from "./schema.js";
import type { PsqlAppDb } from "./types.js";

export type { PsqlAppDb } from "./types.js";

function rowToMeta(row: typeof connections.$inferSelect | undefined): ConnectionMeta | null {
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    agentLabel: row.agentLabel,
    spawn: row.spawn,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    lastUpdatedAt: row.lastUpdatedAt,
    pendingPermission: row.pendingPermission ?? null,
  };
}

/** SQL-backed state manager (Postgres `Pool` or embedded **PGLite** file) via Drizzle. */
export function createPsqlStateManager(db: PsqlAppDb): FlamecastStateManager {
  return {
    async allocateConnectionId() {
      return randomUUID();
    },

    async createConnection(meta: ConnectionMeta) {
      await db.insert(connections).values({
        id: meta.id,
        agentLabel: meta.agentLabel,
        spawn: meta.spawn,
        sessionId: meta.sessionId,
        startedAt: meta.startedAt,
        lastUpdatedAt: meta.lastUpdatedAt,
        pendingPermission: meta.pendingPermission,
        status: "active",
      });
    },

    async updateConnection(id, patch) {
      const updates: Partial<typeof connections.$inferInsert> = {};
      if (patch.sessionId !== undefined) updates.sessionId = patch.sessionId;
      if (patch.lastUpdatedAt !== undefined) updates.lastUpdatedAt = patch.lastUpdatedAt;
      if (patch.pendingPermission !== undefined)
        updates.pendingPermission = patch.pendingPermission;
      if (Object.keys(updates).length === 0) return;
      await db.update(connections).set(updates).where(eq(connections.id, id));
    },

    async appendLog(connectionId: string, sessionId: string, log: ConnectionLog) {
      await db.insert(connectionLogs).values({
        connectionId,
        sessionId,
        occurredAt: log.timestamp,
        type: log.type,
        data: log.data,
      });
    },

    async getConnectionMeta(id: string) {
      const rows = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.status, "active")))
        .limit(1);
      return rowToMeta(rows[0]);
    },

    async getLogs(connectionId: string): Promise<ConnectionLog[]> {
      const rows = await db
        .select()
        .from(connectionLogs)
        .where(eq(connectionLogs.connectionId, connectionId))
        .orderBy(asc(connectionLogs.id));
      return rows.map((r) => ({
        timestamp: r.occurredAt,
        type: r.type,
        data: r.data,
      }));
    },

    async finalizeConnection(id: string, reason: "killed") {
      if (reason === "killed") {
        await db.update(connections).set({ status: "killed" }).where(eq(connections.id, id));
      }
    },
  };
}
