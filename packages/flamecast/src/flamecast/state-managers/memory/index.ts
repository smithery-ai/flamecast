import type { AgentTemplate, SessionLog } from "../../../shared/session.js";
import type { FlamecastStorage, SessionMeta } from "../../storage.js";

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
  };
}

/** In-memory storage (tests / local tools) */
export class MemoryFlamecastStorage implements FlamecastStorage {
  private templates = new Map<string, StoredAgentTemplate>();
  private managedTemplateIds: string[] = [];
  private sessions = new Map<string, SessionMeta>();
  private logs = new Map<string, SessionLog[]>();

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

  async saveAgentTemplate(template: AgentTemplate): Promise<void> {
    this.templates.set(template.id, {
      template: cloneTemplate(template),
      managed: false,
    });
  }

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
