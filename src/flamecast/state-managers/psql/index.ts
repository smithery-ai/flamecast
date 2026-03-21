import { and, asc, eq } from "drizzle-orm";
import type { SessionLog } from "../../../shared/session.js";
import type { FlamecastStorage, SessionMeta } from "../../storage.js";
import { connectionLogs, connections } from "./schema.js";
import type { PsqlAppDb } from "./types.js";

export type { PsqlAppDb } from "./types.js";

function rowToMeta(row: typeof connections.$inferSelect | undefined): SessionMeta | null {
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    agentName: row.agentName,
    spawn: row.spawn,
    startedAt: row.startedAt,
    lastUpdatedAt: row.lastUpdatedAt,
    pendingPermission: row.pendingPermission ?? null,
  };
}

/** SQL-backed state manager (Postgres `Pool` or embedded **PGLite** file) via Drizzle. */
export function createPsqlStorage(db: PsqlAppDb): FlamecastStorage {
  return {
    async createSession(meta: SessionMeta) {
      await db.insert(connections).values({
        id: meta.id,
        agentName: meta.agentName,
        spawn: meta.spawn,
        sessionId: meta.id,
        startedAt: meta.startedAt,
        lastUpdatedAt: meta.lastUpdatedAt,
        pendingPermission: meta.pendingPermission,
        status: "active",
      });
    },

    async updateSession(id, patch) {
      const updates: Partial<typeof connections.$inferInsert> = {};
      if (patch.lastUpdatedAt !== undefined) updates.lastUpdatedAt = patch.lastUpdatedAt;
      if (patch.pendingPermission !== undefined)
        updates.pendingPermission = patch.pendingPermission;
      if (Object.keys(updates).length === 0) return;
      await db.update(connections).set(updates).where(eq(connections.id, id));
    },

    async appendLog(sessionId: string, log: SessionLog) {
      await db.insert(connectionLogs).values({
        connectionId: sessionId,
        sessionId,
        occurredAt: log.timestamp,
        type: log.type,
        data: log.data,
      });
    },

    async getSessionMeta(id: string) {
      const rows = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.status, "active")))
        .limit(1);
      return rowToMeta(rows[0]);
    },

    async getLogs(sessionId: string): Promise<SessionLog[]> {
      const rows = await db
        .select()
        .from(connectionLogs)
        .where(eq(connectionLogs.connectionId, sessionId))
        .orderBy(asc(connectionLogs.id));
      return rows.map((r) => ({
        timestamp: r.occurredAt,
        type: r.type,
        data: r.data,
      }));
    },

    async finalizeSession(id: string, reason: "terminated") {
      if (reason === "terminated") {
        await db.update(connections).set({ status: "killed" }).where(eq(connections.id, id));
      }
    },
  };
}
