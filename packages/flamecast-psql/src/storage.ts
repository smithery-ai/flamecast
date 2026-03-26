import { and, asc, desc, eq, inArray, not } from "drizzle-orm";
import type {
  AgentTemplate,
  FlamecastStorage,
  RuntimeInstance,
  SessionMeta,
  SessionRuntimeInfo,
} from "@flamecast/sdk";
import { agentTemplates, runtimeInstances, sessions } from "./schema.js";
import type { PsqlAppDb } from "./types.js";

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
    runtime: row.runtime ?? undefined,
  };
}

function rowToTemplate(row: typeof agentTemplates.$inferSelect): AgentTemplate {
  return {
    id: row.id,
    name: row.name,
    spawn: row.spawn,
    runtime: {
      ...row.runtime,
      ...(row.setup ? { setup: row.setup } : {}),
    },
  };
}

/** SQL-backed state manager (Postgres `Pool` or embedded **PGLite** file) via Drizzle. */
export function createStorageFromDb(db: PsqlAppDb): FlamecastStorage {
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
            setup: template.runtime.setup ?? null,
            spawn: template.spawn,
            runtime: template.runtime,
            managed: true,
            sortOrder: index,
          })
          .onConflictDoUpdate({
            target: agentTemplates.id,
            set: {
              name: template.name,
              setup: template.runtime.setup ?? null,
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
          setup: template.runtime.setup ?? null,
          spawn: template.spawn,
          runtime: template.runtime,
          managed: false,
          sortOrder: 0,
        })
        .onConflictDoUpdate({
          target: agentTemplates.id,
          set: {
            name: template.name,
            setup: template.runtime.setup ?? null,
            spawn: template.spawn,
            runtime: template.runtime,
            managed: false,
            sortOrder: 0,
          },
        });
    },

    async createSession(meta: SessionMeta, runtimeInfo?: SessionRuntimeInfo) {
      await db.insert(sessions).values({
        id: meta.id,
        agentName: meta.agentName,
        spawn: meta.spawn,
        startedAt: meta.startedAt,
        lastUpdatedAt: meta.lastUpdatedAt,
        pendingPermission: meta.pendingPermission,
        status: "active",
        hostUrl: runtimeInfo?.hostUrl ?? null,
        websocketUrl: runtimeInfo?.websocketUrl ?? null,
        runtimeName: runtimeInfo?.runtimeName ?? null,
        runtimeMeta: runtimeInfo?.runtimeMeta ?? null,
        runtime: meta.runtime ?? null,
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

    async getSessionMeta(id: string) {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return rowToMeta(rows[0]);
    },

    async listAllSessions() {
      const rows = await db.select().from(sessions).orderBy(desc(sessions.lastUpdatedAt));
      return rows.map(rowToMeta).filter((meta): meta is SessionMeta => meta !== null);
    },

    async listActiveSessionsWithRuntime() {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.status, "active"))
        .orderBy(desc(sessions.lastUpdatedAt));
      return rows.reduce<Array<SessionMeta & { runtimeInfo: SessionRuntimeInfo | null }>>(
        (acc, row) => {
          const meta = rowToMeta(row);
          if (!meta) return acc;
          const runtimeInfo: SessionRuntimeInfo | null =
            row.hostUrl && row.websocketUrl && row.runtimeName
              ? {
                  hostUrl: row.hostUrl,
                  websocketUrl: row.websocketUrl,
                  runtimeName: row.runtimeName,
                  runtimeMeta: row.runtimeMeta,
                }
              : null;
          acc.push({ ...meta, runtimeInfo });
          return acc;
        },
        [],
      );
    },

    async finalizeSession(id: string, _reason: "terminated") {
      await db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, id));
    },

    async saveRuntimeInstance(instance: RuntimeInstance) {
      await db
        .insert(runtimeInstances)
        .values({
          name: instance.name,
          typeName: instance.typeName,
          status: instance.status,
        })
        .onConflictDoUpdate({
          target: runtimeInstances.name,
          set: {
            typeName: instance.typeName,
            status: instance.status,
          },
        });
    },

    async listRuntimeInstances() {
      const rows = await db.select().from(runtimeInstances);
      return rows.map((row) => {
        const status =
          row.status === "stopped" ? "stopped" : row.status === "paused" ? "paused" : "running";
        return { name: row.name, typeName: row.typeName, status };
      });
    },

    async deleteRuntimeInstance(name: string) {
      await db.delete(runtimeInstances).where(eq(runtimeInstances.name, name));
    },
  };
}
