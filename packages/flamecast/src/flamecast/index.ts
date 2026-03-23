import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  CreateSessionBody,
  FilePreview,
  RegisterAgentTemplateBody,
  Session,
  SessionLog,
} from "../shared/session.js";
import { createServerApp } from "../server/app.js";
import { getBuiltinAgentTemplates, localRuntime } from "./agent-templates.js";
import type { FlamecastStorage, StorageConfig } from "./storage.js";
import { resolveStorage } from "./storage.js";
import type { RuntimeProviderRegistry } from "./runtime-provider.js";
import { resolveRuntimeProviders } from "./runtime-provider.js";
import type { RuntimeClient } from "../runtime/client.js";
import { LocalRuntimeClient } from "../runtime/local.js";

export type { AgentSpawn, AgentTemplate, PendingPermission, Session } from "../shared/session.js";
export type { SessionMeta, FlamecastStorage, StorageConfig } from "./storage.js";
export type { RuntimeProvider, RuntimeProviderRegistry } from "./runtime-provider.js";
export type { AppType } from "./api.js";
export type { AcpTransport } from "./transport.js";
export type { RuntimeClient } from "../runtime/client.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export type FlamecastOptions = {
  storage?: StorageConfig;
  runtimeProviders?: RuntimeProviderRegistry;
  agentTemplates?: AgentTemplate[];
  handleSignals?: boolean;
  onSessionEvent?: (sessionId: string, event: SessionLog) => void;
  runtimeClient?: RuntimeClient;
};

export class Flamecast {
  private readonly initialAgentTemplates: AgentTemplate[];
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly storageConfig?: StorageConfig;
  private readonly handleSignals: boolean;
  private readonly signalHandlers = new Map<ShutdownSignal, () => void>();
  private readonly runtimeClient: RuntimeClient;
  private storage: FlamecastStorage | null = null;
  private readyPromise: Promise<void> | null = null;
  private server: ServerType | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly app = createServerApp(this);

  readonly fetch: (request: Request) => Promise<Response>;

  constructor(opts: FlamecastOptions = {}) {
    this.storageConfig = opts.storage;
    this.handleSignals = opts.handleSignals ?? true;
    this.runtimeProviders = resolveRuntimeProviders(opts.runtimeProviders);
    this.initialAgentTemplates = opts.agentTemplates ?? getBuiltinAgentTemplates();

    this.runtimeClient =
      opts.runtimeClient ??
      new LocalRuntimeClient({
        runtimeProviders: this.runtimeProviders,
        getStorage: () => this.requireStorage(),
        onSessionEvent: opts.onSessionEvent,
      });

    this.fetch = async (request: Request) => this.app.fetch(request);
  }

  async listen(port = 3001) {
    if (this.server) {
      throw new Error("Flamecast is already listening");
    }

    await this.ensureReady();
    const server = serve({ fetch: this.fetch, port }, (info) => {
      console.log(`Flamecast running on http://localhost:${info.port}`);
    });
    this.server = server;
    this.registerSignalHandlers();
    return server;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    const shutdownPromise = (async () => {
      this.unregisterSignalHandlers();

      for (const session of await this.listSessions()) {
        await this.terminateSession(session.id).catch(() => {});
      }

      await this.closeServer();
    })();
    this.shutdownPromise = shutdownPromise;

    try {
      await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) {
        this.shutdownPromise = null;
      }
    }
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    await this.ensureReady();
    return this.requireStorage().listAgentTemplates();
  }

  async registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate> {
    await this.ensureReady();

    const template: AgentTemplate = {
      id: randomUUID(),
      name: body.name,
      spawn: {
        command: body.spawn.command,
        args: [...body.spawn.args],
      },
      runtime: body.runtime ? { ...body.runtime } : localRuntime(),
    };

    await this.requireStorage().saveAgentTemplate(template);
    return template;
  }

  async createSession(opts: CreateSessionBody): Promise<Session> {
    await this.ensureReady();

    const cwd = opts.cwd ?? process.cwd();
    const { agentName, spawn, runtime } = await this.resolveSessionDefinition(opts);
    const startedAt = new Date().toISOString();

    const { sessionId } = await this.runtimeClient.startSession({
      agentName,
      spawn,
      cwd,
      runtime,
      startedAt,
    });

    return this.snapshotSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    await this.ensureReady();
    const allMetas = await this.requireStorage().listAllSessions();
    return Promise.all(allMetas.map((meta) => this.snapshotSession(meta.id)));
  }

  async getSession(
    id: string,
    opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    await this.ensureReady();
    if (!this.runtimeClient.hasSession(id)) {
      const meta = await this.requireStorage().getSessionMeta(id);
      if (!meta) throw new Error(`Session "${id}" not found`);
    }
    return this.snapshotSession(id, opts);
  }

  async getFilePreview(id: string, path: string): Promise<FilePreview> {
    await this.ensureReady();
    return this.runtimeClient.getFilePreview(id, path);
  }

  async promptSession(
    id: string,
    text: string,
  ): Promise<import("@agentclientprotocol/sdk").PromptResponse> {
    await this.ensureReady();
    if (!this.runtimeClient.hasSession(id)) {
      const meta = await this.requireStorage().getSessionMeta(id);
      if (meta?.status === "killed") {
        throw new Error("Cannot prompt a terminated session");
      }
    }
    return this.runtimeClient.promptSession(id, text);
  }

  async terminateSession(id: string): Promise<void> {
    await this.ensureReady();
    if (!this.runtimeClient.hasSession(id)) {
      const meta = await this.requireStorage().getSessionMeta(id);
      if (meta?.status === "killed") {
        throw new Error("Cannot terminate an already-killed session");
      }
    }
    await this.runtimeClient.terminateSession(id);
  }

  subscribe(sessionId: string, callback: (event: SessionLog) => void): () => void {
    return this.runtimeClient.subscribe(sessionId, callback);
  }

  async respondToPermission(
    id: string,
    requestId: string,
    body: import("../shared/session.js").PermissionResponseBody,
  ): Promise<void> {
    await this.ensureReady();
    await this.runtimeClient.resolvePermission(id, requestId, body);
  }

  private registerSignalHandlers(): void {
    if (!this.handleSignals || this.signalHandlers.size > 0) {
      return;
    }

    for (const signal of ["SIGTERM", "SIGINT"] satisfies ShutdownSignal[]) {
      const handler = () => {
        void this.shutdownFromSignal(signal);
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  private unregisterSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();
  }

  private async shutdownFromSignal(signal: ShutdownSignal): Promise<void> {
    if (this.shutdownPromise) {
      return;
    }

    console.log("\nShutting down...");

    try {
      await this.shutdown();
      process.exit(0);
    } catch (error) {
      console.error(`Failed to shut down Flamecast cleanly after ${signal}.`, error);
      process.exit(1);
    }
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;

    if (!server) {
      return;
    }

    const closePromise = new Promise<void>((resolve, reject) => {
      try {
        if (server.close.length === 0) {
          server.close();
          resolve();
          return;
        }

        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });

    await Promise.race([
      closePromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("server close timed out")), 10_000),
      ),
    ]);
  }

  private async ensureReady(): Promise<void> {
    if (this.storage) return;
    if (!this.readyPromise) {
      this.readyPromise = resolveStorage(this.storageConfig).then((storage) => {
        this.storage = storage;
        return storage.seedAgentTemplates(this.initialAgentTemplates);
      });
    }
    await this.readyPromise;
  }

  private requireStorage(): FlamecastStorage {
    if (!this.storage) {
      throw new Error("Flamecast storage is not ready");
    }
    return this.storage;
  }

  private async resolveSessionDefinition(opts: CreateSessionBody): Promise<{
    agentName: string;
    spawn: AgentSpawn;
    runtime: AgentTemplateRuntime;
  }> {
    if (opts.agentTemplateId) {
      const template = await this.requireStorage().getAgentTemplate(opts.agentTemplateId);
      if (!template) {
        throw new Error(`Unknown agent template "${opts.agentTemplateId}"`);
      }

      return {
        agentName: template.name,
        spawn: {
          command: template.spawn.command,
          args: [...template.spawn.args],
        },
        runtime: { ...template.runtime },
      };
    }

    if (!opts.spawn) {
      throw new Error("Provide agentTemplateId or spawn");
    }

    return {
      agentName:
        opts.name?.trim() ||
        [opts.spawn.command, ...(opts.spawn.args ?? [])].filter(Boolean).join(" "),
      spawn: {
        command: opts.spawn.command,
        args: [...(opts.spawn.args ?? [])],
      },
      runtime: localRuntime(),
    };
  }

  private async snapshotSession(
    id: string,
    opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    const storage = this.requireStorage();
    const meta = await storage.getSessionMeta(id);
    if (!meta) {
      throw new Error(`Session "${id}" not found`);
    }
    const logs = await storage.getLogs(id);
    let fileSystem = null;
    if (opts.includeFileSystem) {
      fileSystem = await this.runtimeClient.getFileSystemSnapshot(id, {
        showAllFiles: opts.showAllFiles,
      });
    }
    return {
      ...meta,
      logs: [...logs],
      pendingPermission: meta.pendingPermission
        ? {
            ...meta.pendingPermission,
            options: meta.pendingPermission.options.map((option) => ({ ...option })),
          }
        : null,
      fileSystem,
    };
  }
}
