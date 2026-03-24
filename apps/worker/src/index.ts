/**
 * Flamecast Worker — edge runtime entry point.
 *
 * Serverless-compatible: no child_process, no Node fs, no Docker.
 * Uses SessionManager for data plane provisioning and per-request
 * postgres.js storage via Hyperdrive.
 */
import { getContainer } from "@cloudflare/containers";
import { createServerApp } from "@flamecast/sdk/server/app";
import { SessionManager } from "@flamecast/sdk/session-manager";
import { createPsqlStorage } from "@flamecast/storage-psql";
import type { FlamecastApi } from "@flamecast/sdk/api";
import type { DataPlaneBinding } from "@flamecast/sdk/data-plane";
import type { FlamecastStorage } from "@flamecast/sdk/storage";
import type {
  AgentTemplate,
  CreateSessionBody,
  RegisterAgentTemplateBody,
  Session,
  AgentTemplateRuntime,
} from "@flamecast/sdk/shared/session";
import type { FlamecastRuntime } from "./container.ts";

// Re-export the Container class — required by CF Containers so Cloudflare
// can route Durable Object requests to container instances.
export { FlamecastRuntime } from "./container.ts";

type Env = {
  DATABASE: { connectionString: string };
  /** Local mode: URL string to session router */
  RUNTIME_URL?: string;
  /** Deployed mode: CF Container DurableObjectNamespace */
  RUNTIME?: DurableObjectNamespace<FlamecastRuntime>;
  WORKSPACE_ROOT?: string;
};

function createBindingFromUrl(runtimeUrl: string): DataPlaneBinding {
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

function createBindingFromContainer(
  binding: DurableObjectNamespace<FlamecastRuntime>,
): DataPlaneBinding {
  return {
    async fetchSession(sessionId: string, request: Request): Promise<Response> {
      const container = getContainer(binding, sessionId);
      return container.fetch(request);
    },
  };
}

function createWorkerApi(
  storage: FlamecastStorage,
  sessionManager: SessionManager,
  defaultCwd: string,
  requestUrl?: string,
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

    // In deployed mode, override the bridge's internal ws://localhost URL
    // with the Worker's public WebSocket proxy endpoint.
    let websocketUrl = sessionManager.getWebsocketUrl(id);
    if (requestUrl) {
      const origin = new URL(requestUrl).origin.replace(/^http/, "ws");
      websocketUrl = `${origin}/api/agents/${id}/ws`;
    }

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
      websocketUrl,
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
let sessionManager: SessionManager | null = null;

export default {
  async fetch(request: Request, env: Env) {
    if (!sessionManager) {
      const binding = env.RUNTIME
        ? createBindingFromContainer(env.RUNTIME)
        : createBindingFromUrl(env.RUNTIME_URL ?? "");
      sessionManager = new SessionManager(binding);
    }

    // WebSocket proxy: /api/agents/:id/ws → container bridge
    const url = new URL(request.url);
    const wsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/ws$/);
    if (wsMatch && request.headers.get("Upgrade") === "websocket") {
      const id = wsMatch[1];
      return sessionManager.proxyWebSocket(id, request);
    }

    const storage = await createPsqlStorage({ url: env.DATABASE.connectionString });
    const defaultCwd = env.WORKSPACE_ROOT ?? "/workspace";
    // Only pass requestUrl in deployed mode — used to rewrite websocketUrl
    // from the container's internal ws://localhost:8080 to the Worker's proxy.
    const api = createWorkerApi(
      storage,
      sessionManager,
      defaultCwd,
      env.RUNTIME ? request.url : undefined,
    );
    const app = createServerApp(api);
    return app.fetch(request);
  },
};
