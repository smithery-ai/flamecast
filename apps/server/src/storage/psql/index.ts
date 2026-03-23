import { and, asc, desc, eq, inArray, not } from "drizzle-orm";
import type { FlamecastStorage, SessionMeta } from "@flamecast/sdk";
import type { AgentTemplate, SessionLog } from "@flamecast/sdk/shared/session";
import { agentTemplates, sessionLogs, sessions } from "./schema.js";
import type { PsqlAppDb } from "./types.js";

export type { PsqlAppDb } from "./types.js";

function rowToMeta(row: typeof sessions.$inferSelect | undefined): SessionMeta | null {
  if (!row) return null;
  const status = row.status === "killed" ? "killed" : "active";
  return {
    id: row.id,
    agentName: row.agentName,
    spawn: row.spawn,
    startedAt: row.startedAt,
    lastUpdatedAt: row.lastUpdatedAt,
    status,
    pendingPermission: row.pendingPermission,
  };
}

function rowToTemplate(row: typeof agentTemplates.$inferSelect): AgentTemplate {
  return {
    id: row.id,
    name: row.name,
    spawn: row.spawn,
    runtime: row.runtime,
  };
}

/** SQL-backed state manager (Postgres `Pool` or embedded **PGLite** file) via Drizzle. */
export function createPsqlStorage(db: PsqlAppDb): FlamecastStorage {
  return {
    async seedAgentTemplates(templates: AgentTemplate[]) {
      const managedTemplateIds = templates.map((template) => template.id);

      if (managedTemplateIds.length === 0) {
        await db.delete(agentTemplates).where(eq(agentTemplates.managed, true));
      } else {
        await db
          .delete(agentTemplates)
          .where(
            and(
              eq(agentTemplates.managed, true),
              not(inArray(agentTemplates.id, managedTemplateIds)),
            ),
          );
      }

      for (const [index, template] of templates.entries()) {
        await db
          .insert(agentTemplates)
          .values({
            id: template.id,
            name: template.name,
            spawn: template.spawn,
            runtime: template.runtime,
            managed: true,
            sortOrder: index,
          })
          .onConflictDoUpdate({
            target: agentTemplates.id,
            set: {
              name: template.name,
              spawn: template.spawn,
              runtime: template.runtime,
              managed: true,
              sortOrder: index,
            },
          });
      }
    },

    async listAgentTemplates() {
      const rows = await db
        .select()
        .from(agentTemplates)
        .orderBy(
          desc(agentTemplates.managed),
          asc(agentTemplates.sortOrder),
          asc(agentTemplates.createdAt),
          asc(agentTemplates.id),
        );

      return rows.map(rowToTemplate);
    },

    async getAgentTemplate(id: string) {
      const rows = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1);
      return rows[0] ? rowToTemplate(rows[0]) : null;
    },

    async saveAgentTemplate(template: AgentTemplate) {
      await db
        .insert(agentTemplates)
        .values({
          id: template.id,
          name: template.name,
          spawn: template.spawn,
          runtime: template.runtime,
          managed: false,
          sortOrder: 0,
        })
        .onConflictDoUpdate({
          target: agentTemplates.id,
          set: {
            name: template.name,
            spawn: template.spawn,
            runtime: template.runtime,
            managed: false,
            sortOrder: 0,
          },
        });
    },

    async createSession(meta: SessionMeta) {
      await db.insert(sessions).values({
        id: meta.id,
        agentName: meta.agentName,
        spawn: meta.spawn,
        startedAt: meta.startedAt,
        lastUpdatedAt: meta.lastUpdatedAt,
        pendingPermission: meta.pendingPermission,
        status: "active",
      });
    },

    async updateSession(id, patch) {
      const updates: Partial<typeof sessions.$inferInsert> = {};
      if (patch.lastUpdatedAt !== undefined) updates.lastUpdatedAt = patch.lastUpdatedAt;
      if (patch.pendingPermission !== undefined)
        updates.pendingPermission = patch.pendingPermission;
      if (Object.keys(updates).length === 0) return;
      await db.update(sessions).set(updates).where(eq(sessions.id, id));
    },

    async appendLog(sessionId: string, log: SessionLog) {
      await db.insert(sessionLogs).values({
        sessionId,
        occurredAt: log.timestamp,
        type: log.type,
        data: log.data,
      });
    },

    async getSessionMeta(id: string) {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return rowToMeta(rows[0]);
    },

    async getLogs(sessionId: string): Promise<SessionLog[]> {
      const rows = await db
        .select()
        .from(sessionLogs)
        .where(eq(sessionLogs.sessionId, sessionId))
        .orderBy(asc(sessionLogs.id));
      return rows.map((r) => ({
        timestamp: r.occurredAt,
        type: r.type,
        data: r.data,
      }));
    },

    async listAllSessions() {
      const rows = await db.select().from(sessions).orderBy(desc(sessions.lastUpdatedAt));
      return rows.map(rowToMeta).filter((meta): meta is SessionMeta => meta !== null);
    },

    async finalizeSession(id: string, _reason: "terminated") {
      await db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, id));
    },
  };
}
