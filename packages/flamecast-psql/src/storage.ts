import { and, asc, desc, eq, inArray, not } from "drizzle-orm";
import type {
  FlamecastStorage,
  QueuedMessage,
  SessionMeta,
  SessionRuntimeInfo,
  StoredSession,
} from "@flamecast/protocol";
import type { RuntimeInstance } from "@flamecast/protocol/runtime";
import type { AgentTemplate } from "@flamecast/protocol/session";
import { agentTemplates, messageQueue, runtimeInstances, sessions } from "./schema.js";
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
    cwd: row.cwd ?? undefined,
    title: row.title ?? undefined,
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
    ...(row.env ? { env: row.env } : {}),
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
            env: template.env ?? null,
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
              env: template.env ?? null,
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

    async updateAgentTemplate(
      id: string,
      patch: {
        name?: string;
        spawn?: AgentTemplate["spawn"];
        runtime?: Partial<AgentTemplate["runtime"]>;
        env?: Record<string, string>;
      },
    ) {
      const existing = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .limit(1);
      if (!existing[0]) return null;

      const existingTemplate = rowToTemplate(existing[0]);
      const mergedRuntime = patch.runtime
        ? { ...existingTemplate.runtime, ...patch.runtime }
        : existingTemplate.runtime;
      const merged: AgentTemplate = {
        ...existingTemplate,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.spawn !== undefined ? { spawn: patch.spawn } : {}),
        runtime: mergedRuntime,
        ...(patch.env !== undefined ? { env: patch.env } : {}),
      };

      const set: Partial<typeof agentTemplates.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.spawn !== undefined) set.spawn = patch.spawn;
      if (patch.runtime !== undefined) {
        set.runtime = mergedRuntime;
        set.setup = mergedRuntime.setup ?? null;
      }
      if (patch.env !== undefined) set.env = patch.env ?? null;

      if (Object.keys(set).length > 0) {
        await db.update(agentTemplates).set(set).where(eq(agentTemplates.id, id));
      }

      return merged;
    },

    async saveAgentTemplate(template: AgentTemplate) {
      await db
        .insert(agentTemplates)
        .values({
          id: template.id,
          name: template.name,
          setup: template.runtime.setup ?? null,
          env: template.env ?? null,
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
            env: template.env ?? null,
            spawn: template.spawn,
            runtime: template.runtime,
            managed: false,
            sortOrder: 0,
          },
        });
    },

    async createSession(
      meta: SessionMeta,
      runtimeInfo?: SessionRuntimeInfo,
      webhooks: NonNullable<StoredSession["webhooks"]> = [],
    ) {
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
        cwd: meta.cwd ?? null,
        title: meta.title ?? null,
        webhooks,
      });
    },

    async updateSession(
      id: string,
      patch: Partial<Pick<SessionMeta, "lastUpdatedAt" | "pendingPermission" | "title">>,
    ) {
      const updates: Partial<typeof sessions.$inferInsert> = {};
      if (patch.lastUpdatedAt !== undefined) updates.lastUpdatedAt = patch.lastUpdatedAt;
      if (patch.pendingPermission !== undefined)
        updates.pendingPermission = patch.pendingPermission;
      if (patch.title !== undefined) updates.title = patch.title;
      if (Object.keys(updates).length === 0) return;
      await db.update(sessions).set(updates).where(eq(sessions.id, id));
    },

    async getSessionMeta(id: string) {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return rowToMeta(rows[0]);
    },

    async getStoredSession(id: string): Promise<StoredSession | null> {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const row = rows[0];
      const meta = rowToMeta(row);
      if (!row || !meta) return null;

      const runtimeInfo: SessionRuntimeInfo | null =
        row.hostUrl && row.websocketUrl && row.runtimeName
          ? {
              hostUrl: row.hostUrl,
              websocketUrl: row.websocketUrl,
              runtimeName: row.runtimeName,
              runtimeMeta: row.runtimeMeta,
            }
          : null;

      return {
        meta,
        runtimeInfo,
        webhooks: row.webhooks ?? [],
      };
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
      return rows.reduce<StoredSession[]>((acc, row) => {
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
        acc.push({
          meta,
          runtimeInfo,
          webhooks: row.webhooks ?? [],
        });
        return acc;
      }, []);
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
          websocketUrl: instance.websocketUrl,
        })
        .onConflictDoUpdate({
          target: runtimeInstances.name,
          set: {
            typeName: instance.typeName,
            status: instance.status,
            websocketUrl: instance.websocketUrl,
          },
        });
    },

    async listRuntimeInstances() {
      const rows = await db
        .select()
        .from(runtimeInstances)
        .orderBy(asc(runtimeInstances.createdAt), asc(runtimeInstances.name));
      return rows.map((row) => {
        const status =
          row.status === "stopped" ? "stopped" : row.status === "paused" ? "paused" : "running";
        return {
          name: row.name,
          typeName: row.typeName,
          status,
          ...(row.websocketUrl ? { websocketUrl: row.websocketUrl } : {}),
        };
      });
    },

    async deleteRuntimeInstance(name: string) {
      await db.delete(runtimeInstances).where(eq(runtimeInstances.name, name));
    },

    // ── Message queue ──────────────────────────────────────────────────────

    async enqueueMessage(message) {
      const rows = await db
        .insert(messageQueue)
        .values({
          sessionId: message.sessionId,
          text: message.text,
          runtime: message.runtime,
          agent: message.agent,
          agentTemplateId: message.agentTemplateId,
          directory: message.directory,
          status: "pending",
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Failed to insert message");
      return rowToQueuedMessage(row);
    },

    async listQueuedMessages() {
      const rows = await db
        .select()
        .from(messageQueue)
        .orderBy(asc(messageQueue.createdAt), asc(messageQueue.id));
      return rows.map(rowToQueuedMessage);
    },

    async getNextPendingMessage(sessionId: string) {
      const rows = await db
        .select()
        .from(messageQueue)
        .where(and(eq(messageQueue.sessionId, sessionId), eq(messageQueue.status, "pending")))
        .orderBy(asc(messageQueue.createdAt), asc(messageQueue.id))
        .limit(1);
      return rows[0] ? rowToQueuedMessage(rows[0]) : null;
    },

    async markMessageSent(id: number) {
      await db
        .update(messageQueue)
        .set({ status: "sent", sentAt: new Date().toISOString() })
        .where(eq(messageQueue.id, id));
    },

    async removeMessage(id: number) {
      await db.delete(messageQueue).where(eq(messageQueue.id, id));
    },

    async clearMessageQueue() {
      await db.delete(messageQueue);
    },
  };
}

function rowToQueuedMessage(row: typeof messageQueue.$inferSelect): QueuedMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    text: row.text,
    runtime: row.runtime,
    agent: row.agent,
    agentTemplateId: row.agentTemplateId,
    directory: row.directory,
    status: row.status === "sent" ? "sent" : "pending",
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}
