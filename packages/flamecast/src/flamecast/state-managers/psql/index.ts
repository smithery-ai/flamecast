import { and, asc, desc, eq, inArray, not } from "drizzle-orm";
import type { Agent, AgentTemplate, SessionLog } from "../../../shared/session.js";
import type { AgentMeta, FlamecastStorage, SessionMeta } from "../../storage.js";
import { agentTemplates, agents, sessionLogs, sessions } from "./schema.js";
import type { PsqlAppDb } from "./types.js";

export type { PsqlAppDb } from "./types.js";

function rowToAgent(row: typeof agents.$inferSelect | undefined): AgentMeta | null {
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    agentName: row.agentName,
    spawn: row.spawn,
    runtime: row.runtime,
    startedAt: row.startedAt,
    lastUpdatedAt: row.lastUpdatedAt,
    latestSessionId: row.latestSessionId,
    sessionCount: row.sessionCount,
  };
}

function rowToMeta(row: typeof sessions.$inferSelect | undefined): SessionMeta | null {
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    spawn: row.spawn,
    cwd: row.cwd,
    startedAt: row.startedAt,
    lastUpdatedAt: row.lastUpdatedAt,
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
    async listAgents() {
      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.status, "active"))
        .orderBy(desc(agents.lastUpdatedAt), asc(agents.id));
      return rows.map((row) => rowToAgent(row)).filter((row): row is Agent => row !== null);
    },

    async getAgent(id: string) {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.status, "active")))
        .limit(1);
      return rowToAgent(rows[0]);
    },

    async createAgent(meta: AgentMeta) {
      await db.insert(agents).values({
        id: meta.id,
        agentName: meta.agentName,
        spawn: meta.spawn,
        runtime: meta.runtime,
        startedAt: meta.startedAt,
        lastUpdatedAt: meta.lastUpdatedAt,
        latestSessionId: meta.latestSessionId,
        sessionCount: meta.sessionCount,
        status: "active",
      });
    },

    async updateAgent(id, patch) {
      const updates: Partial<typeof agents.$inferInsert> = {};
      if (patch.lastUpdatedAt !== undefined) updates.lastUpdatedAt = patch.lastUpdatedAt;
      if (patch.latestSessionId !== undefined) updates.latestSessionId = patch.latestSessionId;
      if (patch.sessionCount !== undefined) updates.sessionCount = patch.sessionCount;
      if (Object.keys(updates).length === 0) return;
      await db.update(agents).set(updates).where(eq(agents.id, id));
    },

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
        agentId: meta.agentId,
        agentName: meta.agentName,
        spawn: meta.spawn,
        cwd: meta.cwd,
        startedAt: meta.startedAt,
        lastUpdatedAt: meta.lastUpdatedAt,
        pendingPermission: meta.pendingPermission,
        status: "active",
      });
    },

    async listSessionsByAgent(agentId: string) {
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.agentId, agentId), eq(sessions.status, "active")))
        .orderBy(desc(sessions.lastUpdatedAt), asc(sessions.id));
      return rows.map((row) => rowToMeta(row)).filter((row): row is SessionMeta => row !== null);
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
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.status, "active")))
        .limit(1);
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

    async finalizeSession(id: string, _reason: "terminated") {
      await db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, id));
    },

    async finalizeAgent(id: string, _reason: "terminated") {
      await db.update(agents).set({ status: "killed" }).where(eq(agents.id, id));
    },
  };
}
