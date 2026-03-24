import { createServerApp } from "./server/app.js";
import { SessionManager } from "./flamecast/session-manager.js";
import { createPsqlStorage } from "@flamecast/storage-psql";
import type { FlamecastApi } from "./flamecast/api.js";
import type { DataPlaneBinding } from "./flamecast/data-plane.js";
import type { FlamecastStorage } from "./flamecast/storage.js";
import type {
  AgentTemplate,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  Session,
  AgentTemplateRuntime,
} from "./shared/session.js";

type Env = {
  DATABASE: { connectionString: string };
  RUNTIME_URL: string;
  WORKSPACE_ROOT?: string;
};

function createBinding(runtimeUrl: string): DataPlaneBinding {
  return {
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const url = new URL(request.url);
      return fetch(`${runtimeUrl}/sessions/${sessionId}${url.pathname}`, {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" ? request.body : undefined,
      });
    },
  };
}

function createWorkerApi(
  storage: FlamecastStorage,
  sessionManager: SessionManager,
  defaultCwd: string,
): FlamecastApi {
  async function resolveSessionDefinition(opts: CreateSessionBody): Promise<{
    agentName: string;
    spawn: { command: string; args: string[] };
    runtime: AgentTemplateRuntime;
  }> {
    if (opts.agentTemplateId) {
      const template = await storage.getAgentTemplate(opts.agentTemplateId);
      if (!template) throw new Error(`Unknown agent template "${opts.agentTemplateId}"`);
      return {
        agentName: template.name,
        spawn: { command: template.spawn.command, args: [...template.spawn.args] },
        runtime: { ...template.runtime },
      };
    }
    if (!opts.spawn) throw new Error("Provide agentTemplateId or spawn");
    return {
      agentName:
        opts.name?.trim() ||
        [opts.spawn.command, ...(opts.spawn.args ?? [])].filter(Boolean).join(" "),
      spawn: { command: opts.spawn.command, args: [...(opts.spawn.args ?? [])] },
      runtime: { provider: "container" },
    };
  }

  async function snapshotSession(id: string): Promise<Session> {
    const meta = await storage.getSessionMeta(id);
    if (!meta) throw new Error(`Session "${id}" not found`);
    return {
      ...meta,
      logs: [],
      pendingPermission: meta.pendingPermission
        ? {
            ...meta.pendingPermission,
            options: meta.pendingPermission.options.map((o) => ({ ...o })),
          }
        : null,
      fileSystem: null,
      promptQueue: null,
      websocketUrl: sessionManager.getWebsocketUrl(id),
    };
  }

  return {
    async listAgentTemplates() {
      return storage.listAgentTemplates();
    },
    async registerAgentTemplate(body: RegisterAgentTemplateBody) {
      const template: AgentTemplate = {
        id: crypto.randomUUID(),
        name: body.name,
        spawn: { command: body.spawn.command, args: [...body.spawn.args] },
        runtime: body.runtime ? { ...body.runtime } : { provider: "container" },
      };
      await storage.saveAgentTemplate(template);
      return template;
    },
    async createSession(opts: CreateSessionBody) {
      const cwd = opts.cwd ?? defaultCwd;
      const { agentName, spawn, runtime } = await resolveSessionDefinition(opts);
      const { sessionId } = await sessionManager.startSession(storage, {
        agentName,
        spawn,
        cwd,
        runtime,
        startedAt: new Date().toISOString(),
      });
      return snapshotSession(sessionId);
    },
    async listSessions() {
      const allMetas = await storage.listAllSessions();
      return Promise.all(allMetas.map((meta) => snapshotSession(meta.id)));
    },
    async getSession(id: string) {
      return snapshotSession(id);
    },
    async terminateSession(id: string) {
      if (!sessionManager.hasSession(id)) {
        const meta = await storage.getSessionMeta(id);
        if (meta?.status === "killed") {
          throw new Error("Cannot terminate an already-killed session");
        }
      }
      await sessionManager.terminateSession(storage, id);
    },
  };
}

// SessionManager is cached across requests (stateful — tracks sessions in memory).
// Storage + Hono app are created per-request because Workers requires I/O objects
// (like postgres connections) to be scoped to the request that created them.
// Hyperdrive handles connection pooling — per-request clients are the correct pattern.
let sessionManager: SessionManager | null = null;

export default {
  async fetch(request: Request, env: Env) {
    const storage = await createPsqlStorage({ url: env.DATABASE.connectionString });
    const binding = createBinding(env.RUNTIME_URL);

    if (!sessionManager) {
      sessionManager = new SessionManager(binding);
    }

    const defaultCwd = env.WORKSPACE_ROOT ?? "/workspace";
    const app = createServerApp(createWorkerApi(storage, sessionManager, defaultCwd));
    return app.fetch(request);
  },
};
