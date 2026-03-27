import type { RuntimeInstance } from "@flamecast/protocol/runtime";
import type { AgentTemplate, WebhookConfig } from "../../../shared/session.js";
import type {
  FlamecastStorage,
  SessionMeta,
  SessionRuntimeInfo,
  StoredSession,
} from "../../storage.js";

type StoredAgentTemplate = {
  template: AgentTemplate;
  managed: boolean;
};

function cloneTemplate(template: AgentTemplate): AgentTemplate {
  return {
    ...template,
    spawn: {
      command: template.spawn.command,
      args: [...template.spawn.args],
    },
    runtime: { ...template.runtime },
    ...(template.env ? { env: { ...template.env } } : {}),
  };
}

/** In-memory storage (tests / local tools) */
export class MemoryFlamecastStorage implements FlamecastStorage {
  private templates = new Map<string, StoredAgentTemplate>();
  private managedTemplateIds: string[] = [];
  private sessions = new Map<string, SessionMeta>();
  private sessionRuntimeInfo = new Map<string, SessionRuntimeInfo>();
  private sessionWebhooks = new Map<string, WebhookConfig[]>();
  private runtimeInstances = new Map<string, RuntimeInstance>();

  async seedAgentTemplates(templates: AgentTemplate[]): Promise<void> {
    const nextManagedIds = templates.map((template) => template.id);
    const nextManagedIdSet = new Set(nextManagedIds);

    for (const [id, row] of this.templates) {
      if (row.managed && !nextManagedIdSet.has(id)) {
        this.templates.delete(id);
      }
    }

    for (const template of templates) {
      this.templates.set(template.id, {
        template: cloneTemplate(template),
        managed: true,
      });
    }

    this.managedTemplateIds = nextManagedIds;
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const managedTemplates = this.managedTemplateIds
      .map((id) => this.templates.get(id))
      .filter((row): row is StoredAgentTemplate => Boolean(row))
      .map((row) => cloneTemplate(row.template));

    const userTemplates: AgentTemplate[] = [];

    for (const [id, row] of this.templates) {
      if (this.managedTemplateIds.includes(id)) continue;
      userTemplates.push(cloneTemplate(row.template));
    }

    return [...managedTemplates, ...userTemplates];
  }

  async getAgentTemplate(id: string): Promise<AgentTemplate | null> {
    const row = this.templates.get(id);
    return row ? cloneTemplate(row.template) : null;
  }

  async updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): Promise<AgentTemplate | null> {
    const row = this.templates.get(id);
    if (!row) return null;
    const existing = cloneTemplate(row.template);
    const merged: AgentTemplate = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.spawn !== undefined ? { spawn: patch.spawn } : {}),
      ...(patch.runtime !== undefined
        ? { runtime: { ...existing.runtime, ...patch.runtime } }
        : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {}),
    };
    this.templates.set(id, { template: cloneTemplate(merged), managed: row.managed });
    return cloneTemplate(merged);
  }

  async saveAgentTemplate(template: AgentTemplate): Promise<void> {
    this.templates.set(template.id, {
      template: cloneTemplate(template),
      managed: false,
    });
  }

  async createSession(
    meta: SessionMeta,
    runtimeInfo?: SessionRuntimeInfo,
    webhooks: WebhookConfig[] = [],
  ): Promise<void> {
    this.sessions.set(meta.id, { ...meta });
    if (runtimeInfo) {
      this.sessionRuntimeInfo.set(meta.id, { ...runtimeInfo });
    }
    this.sessionWebhooks.set(
      meta.id,
      webhooks.map((webhook) => ({ ...webhook })),
    );
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

  async getSessionMeta(id: string): Promise<SessionMeta | null> {
    const row = this.sessions.get(id);
    return row ? { ...row } : null;
  }

  async getStoredSession(id: string): Promise<StoredSession | null> {
    const meta = this.sessions.get(id);
    if (!meta) return null;

    return {
      meta: { ...meta },
      runtimeInfo: this.sessionRuntimeInfo.get(id) ?? null,
      webhooks: (this.sessionWebhooks.get(id) ?? []).map((webhook) => ({ ...webhook })),
    };
  }

  async listAllSessions(): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
  }

  async listActiveSessionsWithRuntime(): Promise<StoredSession[]> {
    return [...this.sessions.values()]
      .filter((row) => row.status === "active")
      .map((row) => ({
        meta: { ...row },
        runtimeInfo: this.sessionRuntimeInfo.get(row.id) ?? null,
        webhooks: (this.sessionWebhooks.get(row.id) ?? []).map((webhook) => ({ ...webhook })),
      }))
      .sort((a, b) => b.meta.lastUpdatedAt.localeCompare(a.meta.lastUpdatedAt));
  }

  async finalizeSession(id: string, _reason: "terminated"): Promise<void> {
    const row = this.sessions.get(id);
    if (row) {
      this.sessions.set(id, { ...row, status: "killed" });
    }
    this.sessionRuntimeInfo.delete(id);
    this.sessionWebhooks.delete(id);
  }

  async saveRuntimeInstance(instance: RuntimeInstance): Promise<void> {
    this.runtimeInstances.set(instance.name, { ...instance });
  }

  async listRuntimeInstances(): Promise<RuntimeInstance[]> {
    return [...this.runtimeInstances.values()].map((r) => ({ ...r }));
  }

  async deleteRuntimeInstance(name: string): Promise<void> {
    this.runtimeInstances.delete(name);
  }
}
