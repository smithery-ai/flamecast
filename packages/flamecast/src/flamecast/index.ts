import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { serve } from "@hono/node-server";
import { AcpStreamableHttpServerTransport } from "../shared/acp-streamable-http-server.js";
import {
  isInitializeRequest,
  parseServerInboundAcpMessages,
} from "../shared/acp-streamable-http-messages.js";
import type {
  Agent,
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  CreateAgentBody,
  CreateSessionBody,
  FilePreview,
  FileSystemEntry,
  FileSystemSnapshot,
  PendingPermission,
  PendingPermissionOption,
  PermissionResponseBody,
  RegisterAgentTemplateBody,
  Session,
  SessionLog,
} from "../shared/session.js";
import { createServerApp } from "../server/app.js";
import { getBuiltinAgentTemplates, localRuntime } from "./agent-templates.js";
import { FlamecastNotFoundError } from "./errors.js";
import type { FlamecastStorage, SessionMeta, StorageConfig } from "./storage.js";
import { resolveStorage } from "./storage.js";
import type { RuntimeProviderRegistry, StartedRuntime } from "./runtime-provider.js";
import { resolveRuntimeProviders } from "./runtime-provider.js";
import type { AcpTransport } from "./transport.js";

export type {
  Agent,
  AgentSpawn,
  CreateAgentBody,
  PendingPermission,
  Session,
} from "../shared/session.js";
export type { AgentMeta, SessionMeta, FlamecastStorage, StorageConfig } from "./storage.js";
export type { RuntimeProvider, RuntimeProviderRegistry } from "./runtime-provider.js";
export type { AppType } from "./api.js";
export type { AcpTransport } from "./transport.js";

type PermissionResolver = (response: acp.RequestPermissionResponse) => void | Promise<void>;
type StreamingTextChunkKind = "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk";

interface SessionTextChunkLogBuffer {
  sessionId: string;
  kind: StreamingTextChunkKind;
  messageId: string | null;
  texts: string[];
}

interface ManagedSession {
  id: string;
  workspaceRoot: string;
  transport: AcpTransport;
  terminate: () => Promise<void>;
  runtime: {
    connection: {
      prompt: (params: acp.PromptRequest) => Promise<acp.PromptResponse>;
    } | null;
    sessionTextChunkLogBuffer: SessionTextChunkLogBuffer | null;
  };
}

interface ManagedAgent {
  id: string;
  agentName: string;
  spawn: AgentSpawn;
  runtime: AgentTemplateRuntime;
  transport: AcpTransport;
  terminate: () => Promise<void>;
  connection: acp.ClientSideConnection;
  sessionTextChunkLogBuffers: Map<string, SessionTextChunkLogBuffer>;
}

interface PendingPermissionState {
  sessionId: string;
  permission: PendingPermission;
  request: acp.RequestPermissionRequest;
  resolve: PermissionResolver;
}

interface PendingSessionBootstrapState {
  agentId: string;
  logs: SessionLog[];
  pendingPermission: PendingPermission | null;
  lastUpdatedAt: string | null;
}

interface UpstreamTransportContext {
  agentId: string;
  transportSessionId: string | null;
  transport: AcpStreamableHttpServerTransport;
  connection: acp.AgentSideConnection | null;
  attachedSessionIds: Set<string>;
}

type GitIgnoreRule = {
  negated: boolean;
  regex: RegExp;
};

export type FlamecastOptions = {
  storage?: StorageConfig;
  runtimeProviders?: RuntimeProviderRegistry;
  agentTemplates?: AgentTemplate[];
};

async function loadGitIgnoreRules(workspaceRoot: string): Promise<GitIgnoreRule[]> {
  const defaultRules = [parseGitIgnoreRule(".git/")].filter(
    (rule): rule is GitIgnoreRule => rule !== null,
  );

  try {
    const content = await readFile(resolve(workspaceRoot, ".gitignore"), "utf8");
    return [
      ...defaultRules,
      ...content
        .split(/\r?\n/u)
        .map(parseGitIgnoreRule)
        .filter((rule): rule is GitIgnoreRule => rule !== null),
    ];
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return defaultRules;
    }
    throw error;
  }
}

function parseGitIgnoreRule(line: string): GitIgnoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const literal = trimmed.startsWith("\\#") || trimmed.startsWith("\\!");
  const negated = !literal && trimmed.startsWith("!");
  const rawPattern = negated ? trimmed.slice(1) : literal ? trimmed.slice(1) : trimmed;

  if (!rawPattern) {
    return null;
  }

  const directoryOnly = rawPattern.endsWith("/");
  const anchored = rawPattern.startsWith("/");
  const normalized = rawPattern.slice(anchored ? 1 : 0, directoryOnly ? -1 : undefined);

  if (!normalized) {
    return null;
  }

  const hasSlash = normalized.includes("/");
  const source = globToRegexSource(normalized);
  const regex = !hasSlash
    ? new RegExp(directoryOnly ? `(^|/)${source}(/|$)` : `(^|/)${source}$`, "u")
    : anchored
      ? new RegExp(directoryOnly ? `^${source}(/|$)` : `^${source}$`, "u")
      : new RegExp(directoryOnly ? `(^|.*/)${source}(/|$)` : `(^|.*/)${source}$`, "u");

  return { negated, regex };
}

function globToRegexSource(pattern: string): string {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`;
      continue;
    }

    source += char;
  }

  return source;
}

function isGitIgnored(path: string, rules: GitIgnoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (rule.regex.test(path)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function describeTransportFailure(transport: AcpTransport): string | null {
  if (!("describeFailure" in transport) || typeof transport.describeFailure !== "function") {
    return null;
  }
  return transport.describeFailure() ?? null;
}

function withTransportFailureContext(
  error: unknown,
  transport: AcpTransport,
  action: string,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const details = describeTransportFailure(transport);
  if (!details || details.includes(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`${action}: ${message}\n\nDownstream runtime error:\n${details}`);
}

function methodNotSupported(method: string): never {
  throw acp.RequestError.methodNotFound(method);
}

function isSessionCloseUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("session/close") && message.includes("Method not found");
}

function clonePromptResponse(
  response: acp.RequestPermissionResponse,
): acp.RequestPermissionResponse {
  return structuredClone(response);
}

export class Flamecast {
  private static readonly MAX_FILE_PREVIEW_CHARS = 20_000;
  private readonly initialAgentTemplates: AgentTemplate[];
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly storageConfig?: StorageConfig;
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly runtimes = new Map<string, ManagedSession>();
  private readonly sessionToAgentId = new Map<string, string>();
  private readonly sessionAttachments = new Map<string, string>();
  private readonly permissionResolvers = new Map<string, PermissionResolver>();
  private readonly pendingPermissions = new Map<string, PendingPermissionState>();
  private readonly pendingSessionBootstraps = new Map<string, PendingSessionBootstrapState>();
  private readonly upstreamContexts = new Map<string, Map<string, UpstreamTransportContext>>();
  private readonly app = createServerApp(this);
  private storage: FlamecastStorage | null = null;
  private readyPromise: Promise<void> | null = null;

  readonly fetch: (request: Request) => Promise<Response>;

  constructor(opts: FlamecastOptions = {}) {
    this.storageConfig = opts.storage;
    this.runtimeProviders = resolveRuntimeProviders(opts.runtimeProviders);
    this.initialAgentTemplates = opts.agentTemplates ?? getBuiltinAgentTemplates();
    this.fetch = async (request: Request) => this.app.fetch(request);
  }

  async listen(port = 3001) {
    await this.ensureReady();
    return serve({ fetch: this.fetch, port }, (info) => {
      console.log(`Flamecast running on http://localhost:${info.port}`);
    });
  }

  async shutdown(): Promise<void> {
    for (const agentId of [...this.agents.keys()]) {
      await this.terminateAgent(agentId).catch(() => {});
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

  async createAgent(opts: CreateAgentBody): Promise<Agent> {
    await this.ensureReady();

    const { agentName, spawn, runtime } = await this.resolveAgentDefinition(opts);
    const provider = this.runtimeProviders[runtime.provider];

    if (!provider) {
      throw new Error(`Unknown runtime provider "${runtime.provider}"`);
    }

    const startedRuntime = await provider.start({ runtime, spawn });
    const stream = acp.ndJsonStream(
      startedRuntime.transport.input,
      startedRuntime.transport.output,
    );
    let managed!: ManagedAgent;
    const agentId = randomUUID();

    const connection = new acp.ClientSideConnection(
      () => this.createDownstreamClient(() => managed),
      stream,
    );
    let runtimeInitialized = false;
    managed = {
      id: agentId,
      agentName,
      spawn,
      runtime,
      transport: startedRuntime.transport,
      terminate: startedRuntime.terminate,
      connection,
      sessionTextChunkLogBuffers: new Map(),
    };

    try {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      const now = new Date().toISOString();
      await this.requireStorage().createAgent({
        id: agentId,
        agentName,
        spawn,
        runtime,
        startedAt: now,
        lastUpdatedAt: now,
        latestSessionId: null,
        sessionCount: 0,
      });

      this.agents.set(agentId, managed);
      runtimeInitialized = true;

      if (opts.initialSessionCwd) {
        try {
          await this.createManagedSession(agentId, {
            cwd: opts.initialSessionCwd,
            mcpServers: [],
          });
        } catch (error) {
          await this.terminateAgent(agentId).catch(() => undefined);
          throw error;
        }
      }

      return this.getAgent(agentId);
    } catch (error) {
      if (runtimeInitialized) {
        throw error;
      }
      const wrappedError = withTransportFailureContext(
        error,
        startedRuntime.transport,
        "Failed to initialize agent runtime",
      );
      await this.stopRuntime(startedRuntime);
      throw wrappedError;
    }
  }

  async listAgents(): Promise<Agent[]> {
    await this.ensureReady();
    return Promise.all([...this.agents.keys()].map((id) => this.getAgent(id)));
  }

  async getAgent(id: string): Promise<Agent> {
    await this.ensureReady();
    this.resolveManagedAgent(id);
    const agent = await this.requireStorage().getAgent(id);
    if (!agent) {
      throw new FlamecastNotFoundError(`Agent "${id}" not found`);
    }
    return agent;
  }

  async createSession(opts: CreateSessionBody): Promise<Session> {
    await this.ensureReady();

    const cwd = await realpath(resolve(opts.cwd ?? process.cwd()));
    const { agentName, spawn, runtime } = await this.resolveSessionDefinition(opts);
    const agent = await this.createAgent({
      name: agentName,
      spawn,
      runtime,
      initialSessionCwd: cwd,
    });

    if (!agent.latestSessionId) {
      throw new Error(`Agent "${agent.id}" did not create an initial ACP session`);
    }

    return this.snapshotSession(agent.latestSessionId);
  }

  async listSessions(): Promise<Session[]> {
    await this.ensureReady();

    if (this.agents.size === 0) {
      return Promise.all([...this.runtimes.keys()].map((id) => this.snapshotSession(id)));
    }

    const sessions = await Promise.all(
      [...this.agents.keys()].map((agentId) => this.requireStorage().listSessionsByAgent(agentId)),
    );

    return Promise.all(
      sessions
        .flat()
        .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt) || a.id.localeCompare(b.id))
        .map((session) => this.snapshotAgentSession(session.agentId, session.id)),
    );
  }

  async getSession(
    id: string,
    opts?: { includeFileSystem?: boolean; showAllFiles?: boolean },
  ): Promise<Session>;
  async getSession(
    agentId: string,
    sessionId: string,
    opts?: { includeFileSystem?: boolean; showAllFiles?: boolean },
  ): Promise<Session>;
  async getSession(
    idOrAgentId: string,
    sessionIdOrOpts:
      | string
      | {
          includeFileSystem?: boolean;
          showAllFiles?: boolean;
        } = {},
    maybeOpts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    await this.ensureReady();

    if (typeof sessionIdOrOpts === "string") {
      this.resolveManagedAgent(idOrAgentId);
      return this.snapshotAgentSession(idOrAgentId, sessionIdOrOpts, maybeOpts);
    }

    return this.snapshotSession(idOrAgentId, sessionIdOrOpts);
  }

  async getFilePreview(id: string, path: string): Promise<FilePreview>;
  async getFilePreview(agentId: string, sessionId: string, path: string): Promise<FilePreview>;
  async getFilePreview(
    idOrAgentId: string,
    sessionIdOrPath: string,
    maybePath?: string,
  ): Promise<FilePreview> {
    await this.ensureReady();

    if (maybePath !== undefined) {
      this.resolveManagedAgent(idOrAgentId);
      const session = await this.getSessionMetaForAgent(idOrAgentId, sessionIdOrPath);
      const absolutePath = await this.resolvePreviewPath(session.cwd, maybePath);
      const content = await readFile(absolutePath, "utf8");
      return {
        path: maybePath,
        content: content.slice(0, Flamecast.MAX_FILE_PREVIEW_CHARS),
        truncated: content.length > Flamecast.MAX_FILE_PREVIEW_CHARS,
        maxChars: Flamecast.MAX_FILE_PREVIEW_CHARS,
      };
    }

    const session = await this.requireSessionMeta(idOrAgentId);
    const workspaceRoot = this.runtimes.get(idOrAgentId)?.workspaceRoot ?? session.cwd;
    const absolutePath = await this.resolvePreviewPath(workspaceRoot, sessionIdOrPath);
    const content = await readFile(absolutePath, "utf8");
    return {
      path: sessionIdOrPath,
      content: content.slice(0, Flamecast.MAX_FILE_PREVIEW_CHARS),
      truncated: content.length > Flamecast.MAX_FILE_PREVIEW_CHARS,
      maxChars: Flamecast.MAX_FILE_PREVIEW_CHARS,
    };
  }

  async getSessionFileSystem(
    agentId: string,
    sessionId: string,
    opts: { showAllFiles?: boolean } = {},
  ): Promise<FileSystemSnapshot> {
    await this.ensureReady();
    this.resolveManagedAgent(agentId);
    const session = await this.getSessionMetaForAgent(agentId, sessionId);
    return this.buildFileSystemSnapshot(session.cwd, {
      showAllFiles: opts.showAllFiles === true,
    });
  }

  async promptSession(id: string, text: string): Promise<acp.PromptResponse> {
    await this.ensureReady();

    const session = await this.requireStorage().getSessionMeta(id);
    if (session && this.agents.has(session.agentId)) {
      return this.promptManagedSession(session.agentId, id, {
        sessionId: id,
        prompt: [{ type: "text", text }],
      });
    }

    const managed = this.runtimes.get(id) ?? null;
    if (managed?.runtime.connection) {
      const promptParams: acp.PromptRequest = {
        sessionId: managed.id,
        prompt: [{ type: "text", text }],
      };

      await this.pushRpcLog(
        managed,
        acp.AGENT_METHODS.session_prompt,
        "client_to_agent",
        "request",
        promptParams,
      );

      try {
        const result = await managed.runtime.connection.prompt(promptParams);
        await this.flushSessionTextChunkLogBuffer(managed);
        await this.pushRpcLog(
          managed,
          acp.AGENT_METHODS.session_prompt,
          "agent_to_client",
          "response",
          result,
        );
        return result;
      } catch (error) {
        await this.flushSessionTextChunkLogBuffer(managed);
        throw error;
      }
    }

    throw new Error(`Session "${id}" is not initialized`);
  }

  async terminateSession(id: string): Promise<void> {
    await this.ensureReady();

    const session = await this.requireStorage().getSessionMeta(id);
    if (session && this.agents.has(session.agentId)) {
      const agentSessions = await this.requireStorage().listSessionsByAgent(session.agentId);
      if (agentSessions.length <= 1) {
        await this.terminateAgent(session.agentId);
        return;
      }
      await this.closeManagedSession(session.agentId, id);
      return;
    }

    const managed = this.resolveRuntime(id);
    const meta = await this.requireStorage().getSessionMeta(id);
    if (meta?.pendingPermission) {
      this.permissionResolvers.delete(meta.pendingPermission.requestId);
      this.pendingPermissions.delete(meta.pendingPermission.requestId);
    }

    await this.flushSessionTextChunkLogBuffer(managed);
    await managed.terminate();
    await this.pushLog(managed, "killed", {});
    await this.requireStorage().finalizeSession(id, "terminated");
    this.runtimes.delete(id);
  }

  async respondToPermission(
    id: string,
    requestId: string,
    body: PermissionResponseBody,
  ): Promise<void> {
    await this.ensureReady();

    const pending = await this.takePendingPermissionResolution(id, requestId);

    if ("outcome" in body && body.outcome === "cancelled") {
      await this.logPermissionCancelled(id, pending);
      await Promise.resolve(pending.resolve({ outcome: { outcome: "cancelled" } }));
      return;
    }

    if (!("optionId" in body)) {
      throw new Error("Invalid permission response");
    }

    const option = this.getPermissionOption(pending, body.optionId);
    await this.logPermissionSelection(id, pending, option);
    await Promise.resolve(
      pending.resolve({
        outcome: { outcome: "selected", optionId: option.optionId },
      }),
    );
  }

  async terminateAgent(id: string): Promise<void> {
    await this.ensureReady();

    const managed = this.resolveManagedAgent(id);
    const sessions = await this.requireStorage().listSessionsByAgent(id);

    for (const session of sessions) {
      const pending = session.pendingPermission;
      if (pending) {
        this.permissionResolvers.delete(pending.requestId);
        this.pendingPermissions.delete(pending.requestId);
      }
      this.runtimes.delete(session.id);
      await this.flushAgentSessionTextChunkLogBuffer(managed, session.id);
      await this.appendLogForSession(session.id, "killed", {});
      this.sessionToAgentId.delete(session.id);
      this.pendingSessionBootstraps.delete(session.id);
      this.detachSession(session.id);
    }

    await managed.terminate();
    await this.requireStorage().finalizeAgent(id, "terminated");
    this.agents.delete(id);

    const contexts = this.upstreamContexts.get(id);
    if (contexts) {
      this.upstreamContexts.delete(id);
      await Promise.all(
        [...contexts.values()].map(async (context) => {
          await context.transport.close().catch(() => undefined);
        }),
      );
    }
  }

  async handleAcp(agentId: string, request: Request): Promise<Response> {
    await this.ensureReady();
    this.resolveManagedAgent(agentId);

    if (!this.isAllowedAcpOrigin(request)) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32003, message: "Forbidden origin" } }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const transportSessionId = request.headers.get("acp-session-id");
    const parsedBody =
      request.method === "POST"
        ? await request
            .clone()
            .json()
            .catch(() => null)
        : undefined;

    if (transportSessionId) {
      const context = this.upstreamContexts.get(agentId)?.get(transportSessionId);
      if (!context) {
        return new Response("ACP transport session not found", { status: 404 });
      }
      return context.transport.handleRequest(
        request,
        parsedBody !== undefined ? { parsedBody } : undefined,
      );
    }

    if (request.method !== "POST" || !this.isInitializeMessage(parsedBody)) {
      return new Response("Missing ACP transport session", { status: 400 });
    }

    const context = this.createUpstreamContext(agentId);
    return context.transport.handleRequest(request, { parsedBody });
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

  private async resolveAgentDefinition(opts: CreateAgentBody): Promise<{
    agentName: string;
    spawn: AgentSpawn;
    runtime: AgentTemplateRuntime;
  }> {
    return {
      agentName:
        opts.name?.trim() ||
        [opts.spawn.command, ...(opts.spawn.args ?? [])].filter(Boolean).join(" "),
      spawn: {
        command: opts.spawn.command,
        args: [...(opts.spawn.args ?? [])],
      },
      runtime: opts.runtime ? { ...opts.runtime } : localRuntime(),
    };
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

  private resolveManagedAgent(id: string): ManagedAgent {
    const managed = this.agents.get(id);
    if (!managed) {
      throw new FlamecastNotFoundError(`Agent "${id}" not found`);
    }
    return managed;
  }

  private resolveRuntime(id: string): ManagedSession {
    const managed = this.runtimes.get(id);
    if (!managed) {
      throw new Error(`Session "${id}" not found`);
    }
    return managed;
  }

  private async requireSessionMeta(id: string): Promise<SessionMeta> {
    const meta = await this.requireStorage().getSessionMeta(id);
    if (!meta) {
      throw new FlamecastNotFoundError(`Session "${id}" not found`);
    }
    return meta;
  }

  private async getSessionMetaForAgent(agentId: string, sessionId: string): Promise<SessionMeta> {
    const session = await this.requireSessionMeta(sessionId);
    if (session.agentId !== agentId) {
      throw new FlamecastNotFoundError(`Session "${sessionId}" not found for agent "${agentId}"`);
    }
    return session;
  }

  private async snapshotAgentSession(
    agentId: string,
    sessionId: string,
    opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    const session = await this.getSessionMetaForAgent(agentId, sessionId);
    return this.snapshotSessionFromMeta(session, opts);
  }

  private async snapshotSession(
    id: string,
    opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    const meta = await this.requireStorage().getSessionMeta(id);
    if (!meta) {
      throw new Error(`Session "${id}" not found`);
    }
    return this.snapshotSessionFromMeta(meta, opts);
  }

  private async snapshotSessionFromMeta(
    meta: SessionMeta,
    opts: { includeFileSystem?: boolean; showAllFiles?: boolean } = {},
  ): Promise<Session> {
    const logs = await this.requireStorage().getLogs(meta.id);
    const managed = this.runtimes.get(meta.id) ?? null;

    return {
      ...meta,
      logs: [...logs],
      pendingPermission: meta.pendingPermission
        ? {
            ...meta.pendingPermission,
            options: meta.pendingPermission.options.map((option) => ({ ...option })),
          }
        : null,
      fileSystem:
        opts.includeFileSystem === true && managed
          ? await this.buildFileSystemSnapshot(managed.workspaceRoot, {
              showAllFiles: opts.showAllFiles === true,
            })
          : null,
    };
  }

  private async buildFileSystemSnapshot(
    workspaceRoot: string,
    opts: { showAllFiles?: boolean } = {},
  ): Promise<FileSystemSnapshot> {
    const entries: FileSystemEntry[] = [];
    const gitIgnoreRules = opts.showAllFiles ? [] : await loadGitIgnoreRules(workspaceRoot);
    const queue = [workspaceRoot];

    for (let index = 0; index < queue.length; index += 1) {
      const dir = queue[index];
      const children = await readdir(dir, { withFileTypes: true });
      children.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const child of children) {
        const absolutePath = resolve(dir, child.name);
        const path = relative(workspaceRoot, absolutePath);
        if (isGitIgnored(path, gitIgnoreRules)) {
          continue;
        }

        const type: FileSystemEntry["type"] = child.isDirectory()
          ? "directory"
          : child.isFile()
            ? "file"
            : child.isSymbolicLink()
              ? "symlink"
              : "other";

        entries.push({ path, type });

        if (type === "directory") {
          queue.push(absolutePath);
        }
      }
    }

    return {
      root: workspaceRoot,
      entries,
      truncated: false,
      maxEntries: entries.length,
    };
  }

  private async resolvePreviewPath(workspaceRoot: string, path: string): Promise<string> {
    if (isAbsolute(path)) {
      throw new Error(`File preview paths must be relative: "${path}"`);
    }

    const requestedPath = resolve(workspaceRoot, path);
    const realPath = await realpath(requestedPath);
    const rel = relative(workspaceRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return realPath;
  }

  private async resolveSessionWorkspaceRoot(workspaceRootOrSessionId: string): Promise<string> {
    const session = await this.requireStorage().getSessionMeta(workspaceRootOrSessionId);
    return session?.cwd ?? workspaceRootOrSessionId;
  }

  private async resolveSessionFilePath(
    workspaceRootOrSessionId: string,
    path: string,
  ): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }

    const workspaceRoot = await this.resolveSessionWorkspaceRoot(workspaceRootOrSessionId);
    const realPath = await realpath(path);
    const rel = relative(workspaceRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return realPath;
  }

  private async resolveSessionWritePath(
    workspaceRootOrSessionId: string,
    path: string,
  ): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }

    const workspaceRoot = await this.resolveSessionWorkspaceRoot(workspaceRootOrSessionId);
    const requestedPath = resolve(path);
    const rel = relative(workspaceRoot, requestedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return requestedPath;
  }

  private async resolveCompatSessionFilePath(workspaceRoot: string, path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }

    const realPath = await realpath(path);
    const rel = relative(workspaceRoot, realPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return realPath;
  }

  private async resolveCompatSessionWritePath(
    workspaceRoot: string,
    path: string,
  ): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error(`File paths must be absolute: "${path}"`);
    }

    const requestedPath = resolve(path);
    const rel = relative(workspaceRoot, requestedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside workspace root`);
    }
    return requestedPath;
  }

  private createLogEntry(type: string, data: Record<string, unknown>): SessionLog {
    return {
      timestamp: new Date().toISOString(),
      type,
      data,
    };
  }

  private createRpcLog(
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): SessionLog {
    const data: Record<string, unknown> = { method, direction, phase };
    if (payload !== undefined) data.payload = payload;
    return this.createLogEntry("rpc", data);
  }

  private async recordAgentSessionCreation(
    agentId: string,
    latestSessionId: string,
    timestamp: string,
  ): Promise<void> {
    const agent = await this.requireStorage().getAgent(agentId);
    const sessionCount = agent ? agent.sessionCount + 1 : 1;
    await this.requireStorage().updateAgent(agentId, {
      latestSessionId,
      sessionCount,
      lastUpdatedAt: timestamp,
    });
  }

  private async syncAgentSessionState(agentId: string): Promise<void> {
    const sessions = await this.requireStorage().listSessionsByAgent(agentId);
    await this.requireStorage().updateAgent(agentId, {
      latestSessionId: sessions[0]?.id ?? null,
      sessionCount: sessions.length,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  private async touchAgentForSession(sessionId: string, timestamp: string): Promise<void> {
    const agentId = this.sessionToAgentId.get(sessionId);
    if (!agentId) return;
    const agent = await this.requireStorage().getAgent(agentId);
    if (!agent) return;
    await this.requireStorage().updateAgent(agentId, { lastUpdatedAt: timestamp });
  }

  private async appendLogForSession(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    opts?: { agentId?: string },
  ): Promise<void> {
    const entry = this.createLogEntry(type, data);
    const storage = this.requireStorage();

    if (!this.sessionToAgentId.has(sessionId) && opts?.agentId) {
      const pending = this.getPendingSessionBootstrap(sessionId, opts.agentId);
      pending.logs.push(entry);
      pending.lastUpdatedAt = entry.timestamp;
      return;
    }

    await storage.appendLog(sessionId, entry);
    await storage.updateSession(sessionId, { lastUpdatedAt: entry.timestamp });
    await this.touchAgentForSession(sessionId, entry.timestamp);
  }

  private async appendRpcLogForSession(
    sessionId: string,
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
    opts?: { agentId?: string },
  ): Promise<void> {
    const entry = this.createRpcLog(method, direction, phase, payload);
    const storage = this.requireStorage();

    if (!this.sessionToAgentId.has(sessionId) && opts?.agentId) {
      const pending = this.getPendingSessionBootstrap(sessionId, opts.agentId);
      pending.logs.push(entry);
      pending.lastUpdatedAt = entry.timestamp;
      return;
    }

    await storage.appendLog(sessionId, entry);
    await storage.updateSession(sessionId, { lastUpdatedAt: entry.timestamp });
    await this.touchAgentForSession(sessionId, entry.timestamp);
  }

  private async pushLog(
    managed: ManagedSession,
    type: string,
    data: Record<string, unknown>,
  ): Promise<SessionLog> {
    const entry = this.createLogEntry(type, data);
    const storage = this.requireStorage();
    await storage.appendLog(managed.id, entry);
    await storage.updateSession(managed.id, { lastUpdatedAt: entry.timestamp });
    return entry;
  }

  private async pushRpcLog(
    managed: ManagedSession,
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    phase: "request" | "response" | "notification",
    payload?: unknown,
  ): Promise<void> {
    const entry = this.createRpcLog(method, direction, phase, payload);
    const storage = this.requireStorage();
    await storage.appendLog(managed.id, entry);
    await storage.updateSession(managed.id, { lastUpdatedAt: entry.timestamp });
  }

  private async flushAgentSessionTextChunkLogBuffer(
    managed: ManagedAgent,
    sessionId: string,
  ): Promise<void> {
    const buffer = managed.sessionTextChunkLogBuffers.get(sessionId) ?? null;
    if (!buffer || buffer.texts.length === 0) {
      managed.sessionTextChunkLogBuffers.delete(sessionId);
      return;
    }

    managed.sessionTextChunkLogBuffers.delete(sessionId);
    await this.flushBufferedTextChunks(sessionId, managed.id, buffer);
  }

  private async flushBufferedTextChunks(
    sessionId: string,
    agentId: string,
    buffer: SessionTextChunkLogBuffer,
  ): Promise<void> {
    if (buffer.texts.length === 0) {
      return;
    }

    let combined: string;
    try {
      combined = buffer.texts.join("");
    } catch (error) {
      await this.appendLogForSession(
        sessionId,
        "rpc_coalesce_error",
        {
          reason: "join_failed",
          message: error instanceof Error ? error.message : String(error),
          partialParts: buffer.texts.length,
        },
        { agentId },
      );

      for (const text of buffer.texts) {
        await this.appendRpcLogForSession(
          sessionId,
          acp.CLIENT_METHODS.session_update,
          "agent_to_client",
          "notification",
          {
            sessionId: buffer.sessionId,
            update: {
              sessionUpdate: buffer.kind,
              content: { type: "text", text },
              ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
            },
          },
          { agentId },
        );
      }
      return;
    }

    const update = {
      sessionUpdate: buffer.kind,
      content: { type: "text" as const, text: combined },
      ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
    } satisfies acp.SessionUpdate;

    await this.appendRpcLogForSession(
      sessionId,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      { sessionId: buffer.sessionId, update },
      { agentId },
    );
  }

  private async flushSessionTextChunkLogBuffer(managed: ManagedSession): Promise<void> {
    const buffer = managed.runtime.sessionTextChunkLogBuffer;
    if (!buffer || buffer.texts.length === 0) {
      managed.runtime.sessionTextChunkLogBuffer = null;
      return;
    }

    managed.runtime.sessionTextChunkLogBuffer = null;

    let combined: string;
    try {
      combined = buffer.texts.join("");
    } catch (error) {
      await this.pushLog(managed, "rpc_coalesce_error", {
        reason: "join_failed",
        message: error instanceof Error ? error.message : String(error),
        partialParts: buffer.texts.length,
      });

      for (const text of buffer.texts) {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_update,
          "agent_to_client",
          "notification",
          {
            sessionId: buffer.sessionId,
            update: {
              sessionUpdate: buffer.kind,
              content: { type: "text", text },
              ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
            },
          },
        );
      }
      return;
    }

    const update = {
      sessionUpdate: buffer.kind,
      content: { type: "text" as const, text: combined },
      ...(buffer.messageId != null ? { messageId: buffer.messageId } : {}),
    } satisfies acp.SessionUpdate;

    await this.pushRpcLog(
      managed,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      {
        sessionId: buffer.sessionId,
        update,
      },
    );
  }

  private async forwardSessionUpdate(params: acp.SessionNotification): Promise<void> {
    const attached = this.resolveAttachedConnection(params.sessionId);
    if (!attached) return;
    await attached.sessionUpdate(params).catch(() => undefined);
  }

  private async logSessionUpdateNotification(
    managed: ManagedAgent,
    params: acp.SessionNotification,
  ): Promise<void> {
    const update = params.update;
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text" &&
      typeof update.content.text === "string"
    ) {
      const kind = update.sessionUpdate;
      const messageId = update.messageId ?? null;
      const buffer = managed.sessionTextChunkLogBuffers.get(params.sessionId) ?? null;

      if (
        buffer &&
        (buffer.sessionId !== params.sessionId ||
          buffer.kind !== kind ||
          (buffer.messageId ?? null) !== messageId)
      ) {
        await this.flushAgentSessionTextChunkLogBuffer(managed, params.sessionId);
      }

      const next = managed.sessionTextChunkLogBuffers.get(params.sessionId);
      if (next) {
        next.texts.push(update.content.text);
      } else {
        managed.sessionTextChunkLogBuffers.set(params.sessionId, {
          sessionId: params.sessionId,
          kind,
          messageId,
          texts: [update.content.text],
        });
      }
      await this.forwardSessionUpdate(params);
      return;
    }

    await this.flushAgentSessionTextChunkLogBuffer(managed, params.sessionId);
    await this.appendRpcLogForSession(
      params.sessionId,
      acp.CLIENT_METHODS.session_update,
      "agent_to_client",
      "notification",
      params,
      { agentId: managed.id },
    );
    await this.forwardSessionUpdate(params);
  }

  private async replayPendingPermission(sessionId: string): Promise<void> {
    const session = await this.requireStorage().getSessionMeta(sessionId);
    if (!session?.pendingPermission) return;
    await this.forwardPendingPermission(session.pendingPermission.requestId);
  }

  private async forwardPendingPermission(requestId: string): Promise<void> {
    const state = this.pendingPermissions.get(requestId);
    if (!state) return;

    const attached = this.resolveAttachedConnection(state.sessionId);
    if (!attached) return;

    try {
      const response = await attached.requestPermission(state.request);
      const current = this.pendingPermissions.get(requestId);
      if (!current || current !== state) return;

      const now = new Date().toISOString();
      await this.requireStorage().updateSession(state.sessionId, {
        pendingPermission: null,
        lastUpdatedAt: now,
      });
      this.pendingPermissions.delete(requestId);
      this.permissionResolvers.delete(requestId);
      await this.appendRpcLogForSession(
        state.sessionId,
        acp.CLIENT_METHODS.session_request_permission,
        "client_to_agent",
        "response",
        response,
      );
      await this.touchAgentForSession(state.sessionId, now);
      await Promise.resolve(state.resolve(clonePromptResponse(response)));
    } catch {
      // Leave the permission pending and replay when another ACP client loads the session.
    }
  }

  private async takePendingPermissionResolution(
    sessionId: string,
    requestId?: string,
    clearAnyForSession = false,
  ): Promise<PendingPermissionState> {
    const meta = await this.requireStorage().getSessionMeta(sessionId);
    const pending = meta?.pendingPermission;
    if (!pending) {
      throw new Error("Permission request not found or already resolved");
    }

    if (!clearAnyForSession && pending.requestId !== requestId) {
      throw new Error("Permission request not found or already resolved");
    }

    const state = this.pendingPermissions.get(pending.requestId);
    const resolve = this.permissionResolvers.get(pending.requestId);
    if (!state || !resolve) {
      throw new Error("Permission request not found or already resolved");
    }

    await this.requireStorage().updateSession(sessionId, { pendingPermission: null });
    this.pendingPermissions.delete(pending.requestId);
    this.permissionResolvers.delete(pending.requestId);
    return { ...state, resolve };
  }

  private async logPermissionCancelled(
    sessionId: string,
    pending: PendingPermissionState,
  ): Promise<void> {
    await this.appendLogForSession(sessionId, "permission_cancelled", {
      requestId: pending.permission.requestId,
      toolCallId: pending.permission.toolCallId,
    });
  }

  private async logPermissionSelection(
    sessionId: string,
    pending: PendingPermissionState,
    option: PendingPermissionOption,
  ): Promise<void> {
    await this.appendLogForSession(sessionId, this.getPermissionLogType(option.kind), {
      requestId: pending.permission.requestId,
      toolCallId: pending.permission.toolCallId,
      optionId: option.optionId,
      optionName: option.name,
    });
  }

  private getPermissionLogType(kind: string): string {
    switch (kind) {
      case "allow_once":
        return "permission_approved";
      case "reject_once":
        return "permission_rejected";
      default:
        return "permission_responded";
    }
  }

  private createPendingPermission(params: acp.RequestPermissionRequest): PendingPermission {
    return {
      requestId: randomUUID(),
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: String(option.kind),
      })),
    };
  }

  private getPermissionOption(
    pending: { permission: PendingPermission; resolve: PermissionResolver },
    optionId: string,
  ): PendingPermissionOption {
    const option = pending.permission.options.find((candidate) => candidate.optionId === optionId);
    if (!option) {
      throw new Error(`Unknown permission option "${optionId}"`);
    }
    return option;
  }

  private createDownstreamClient(getManaged: () => ManagedAgent): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        await this.logSessionUpdateNotification(getManaged(), params);
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.session_request_permission,
          "agent_to_client",
          "request",
          params,
          { agentId: getManaged().id },
        );

        const pendingPermission = this.createPendingPermission(params);
        const now = new Date().toISOString();
        if (!this.sessionToAgentId.has(params.sessionId)) {
          const pending = this.getPendingSessionBootstrap(params.sessionId, getManaged().id);
          pending.pendingPermission = pendingPermission;
          pending.lastUpdatedAt = now;
        } else {
          await this.requireStorage().updateSession(params.sessionId, {
            pendingPermission,
            lastUpdatedAt: now,
          });
        }

        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const state: PendingPermissionState = {
            sessionId: params.sessionId,
            permission: pendingPermission,
            request: params,
            resolve,
          };
          this.pendingPermissions.set(pendingPermission.requestId, state);
          this.permissionResolvers.set(pendingPermission.requestId, resolve);
          void this.forwardPendingPermission(pendingPermission.requestId);
        });
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.fs_read_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const absolutePath = await this.resolveSessionFilePath(params.sessionId, params.path);
        const content = await readFile(absolutePath, "utf8");
        const lines = content.split("\n");
        const startLine = Math.max(params.line ?? 0, 0);
        const limitedLines =
          params.limit != null
            ? lines.slice(startLine, startLine + params.limit)
            : lines.slice(startLine);
        const response: acp.ReadTextFileResponse = { content: limitedLines.join("\n") };
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.fs_read_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.fs_write_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const absolutePath = await this.resolveSessionWritePath(params.sessionId, params.path);
        await writeFile(absolutePath, params.content, "utf8");
        const response: acp.WriteTextFileResponse = {};
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.fs_write_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      createTerminal: async (
        params: acp.CreateTerminalRequest,
      ): Promise<acp.CreateTerminalResponse> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_create,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.CreateTerminalResponse = { terminalId: `stub-${randomUUID()}` };
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_create,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      terminalOutput: async (
        params: acp.TerminalOutputRequest,
      ): Promise<acp.TerminalOutputResponse> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_output,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.TerminalOutputResponse = { output: "", truncated: false };
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_output,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      releaseTerminal: async (
        params: acp.ReleaseTerminalRequest,
      ): Promise<acp.ReleaseTerminalResponse | void> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_release,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.ReleaseTerminalResponse = {};
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_release,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      waitForTerminalExit: async (
        params: acp.WaitForTerminalExitRequest,
      ): Promise<acp.WaitForTerminalExitResponse> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WaitForTerminalExitResponse = { exitCode: 0 };
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      killTerminal: async (
        params: acp.KillTerminalRequest,
      ): Promise<acp.KillTerminalResponse | void> => {
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_kill,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.KillTerminalResponse = {};
        await this.appendRpcLogForSession(
          params.sessionId,
          acp.CLIENT_METHODS.terminal_kill,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      extMethod: async (method: string, params: Record<string, unknown>) => {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
        if (sessionId) {
          await this.appendRpcLogForSession(
            sessionId,
            method,
            "agent_to_client",
            "request",
            params,
          );
        }
        throw acp.RequestError.methodNotFound(method);
      },

      extNotification: async (method: string, params: Record<string, unknown>) => {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
        if (sessionId) {
          await this.appendRpcLogForSession(
            sessionId,
            method,
            "agent_to_client",
            "notification",
            params,
          );
        }
      },
    };
  }

  protected createClient(managed: ManagedSession): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        const update = params.update;
        if (
          (update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk") &&
          update.content.type === "text" &&
          typeof update.content.text === "string"
        ) {
          const kind = update.sessionUpdate;
          const messageId = update.messageId ?? null;
          const buffer = managed.runtime.sessionTextChunkLogBuffer;

          if (
            buffer &&
            (buffer.sessionId !== params.sessionId ||
              buffer.kind !== kind ||
              (buffer.messageId ?? null) !== messageId)
          ) {
            await this.flushSessionTextChunkLogBuffer(managed);
          }

          const next = managed.runtime.sessionTextChunkLogBuffer;
          if (next) {
            next.texts.push(update.content.text);
          } else {
            managed.runtime.sessionTextChunkLogBuffer = {
              sessionId: params.sessionId,
              kind,
              messageId,
              texts: [update.content.text],
            };
          }
          return;
        }

        await this.flushSessionTextChunkLogBuffer(managed);
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_update,
          "agent_to_client",
          "notification",
          params,
        );
      },

      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.session_request_permission,
          "agent_to_client",
          "request",
          params,
        );

        const pendingPermission = this.createPendingPermission(params);
        const now = new Date().toISOString();

        await this.requireStorage().updateSession(managed.id, {
          pendingPermission,
          lastUpdatedAt: now,
        });

        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const state: PendingPermissionState = {
            sessionId: managed.id,
            permission: pendingPermission,
            request: params,
            resolve,
          };
          this.pendingPermissions.set(pendingPermission.requestId, state);
          this.permissionResolvers.set(pendingPermission.requestId, resolve);
        });
      },

      readTextFile: async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_read_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const absolutePath = await this.resolveCompatSessionFilePath(
          managed.workspaceRoot,
          params.path,
        );
        const content = await readFile(absolutePath, "utf8");
        const lines = content.split("\n");
        const startLine = Math.max(params.line ?? 0, 0);
        const limitedLines =
          params.limit != null
            ? lines.slice(startLine, startLine + params.limit)
            : lines.slice(startLine);
        const response: acp.ReadTextFileResponse = { content: limitedLines.join("\n") };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_read_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      writeTextFile: async (
        params: acp.WriteTextFileRequest,
      ): Promise<acp.WriteTextFileResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_write_text_file,
          "agent_to_client",
          "request",
          params,
        );
        const absolutePath = await this.resolveCompatSessionWritePath(
          managed.workspaceRoot,
          params.path,
        );
        await writeFile(absolutePath, params.content, "utf8");
        const response: acp.WriteTextFileResponse = {};
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.fs_write_text_file,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      createTerminal: async (
        params: acp.CreateTerminalRequest,
      ): Promise<acp.CreateTerminalResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_create,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.CreateTerminalResponse = { terminalId: `stub-${randomUUID()}` };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_create,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      terminalOutput: async (
        params: acp.TerminalOutputRequest,
      ): Promise<acp.TerminalOutputResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_output,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.TerminalOutputResponse = { output: "", truncated: false };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_output,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      releaseTerminal: async (
        params: acp.ReleaseTerminalRequest,
      ): Promise<acp.ReleaseTerminalResponse | void> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_release,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.ReleaseTerminalResponse = {};
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_release,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      waitForTerminalExit: async (
        params: acp.WaitForTerminalExitRequest,
      ): Promise<acp.WaitForTerminalExitResponse> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.WaitForTerminalExitResponse = { exitCode: 0 };
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_wait_for_exit,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      killTerminal: async (
        params: acp.KillTerminalRequest,
      ): Promise<acp.KillTerminalResponse | void> => {
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_kill,
          "agent_to_client",
          "request",
          params,
        );
        const response: acp.KillTerminalResponse = {};
        await this.pushRpcLog(
          managed,
          acp.CLIENT_METHODS.terminal_kill,
          "client_to_agent",
          "response",
          response,
        );
        return response;
      },

      extMethod: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        await this.pushRpcLog(managed, method, "agent_to_client", "request", params);
        throw acp.RequestError.methodNotFound(method);
      },

      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        await this.pushRpcLog(managed, method, "agent_to_client", "notification", params);
      },
    };
  }

  private createUpstreamContext(agentId: string): UpstreamTransportContext {
    const context: UpstreamTransportContext = {
      agentId,
      transportSessionId: null,
      transport: new AcpStreamableHttpServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          context.transportSessionId = sessionId;
          const contexts = this.upstreamContexts.get(agentId) ?? new Map();
          contexts.set(sessionId, context);
          this.upstreamContexts.set(agentId, contexts);
        },
        onsessionclosed: (sessionId) => {
          this.removeUpstreamContext(agentId, sessionId);
        },
      }),
      connection: null,
      attachedSessionIds: new Set(),
    };

    context.connection = new acp.AgentSideConnection(
      () => this.createNorthboundAgent(context),
      context.transport.stream,
    );
    void context.connection.closed.finally(() => {
      if (context.transportSessionId) {
        this.removeUpstreamContext(agentId, context.transportSessionId);
      }
    });
    return context;
  }

  private removeUpstreamContext(agentId: string, transportSessionId: string): void {
    const contexts = this.upstreamContexts.get(agentId);
    const context = contexts?.get(transportSessionId);
    if (!contexts || !context) return;

    for (const sessionId of context.attachedSessionIds) {
      if (this.sessionAttachments.get(sessionId) === transportSessionId) {
        this.sessionAttachments.delete(sessionId);
      }
    }

    contexts.delete(transportSessionId);
    if (contexts.size === 0) {
      this.upstreamContexts.delete(agentId);
    }
  }

  private createNorthboundAgent(context: UpstreamTransportContext): acp.Agent {
    const agentId = context.agentId;
    const requireTransportSessionId = () => {
      if (!context.transportSessionId) {
        throw acp.RequestError.internalError(undefined, "ACP transport session not initialized");
      }
      return context.transportSessionId;
    };

    return {
      initialize: async (): Promise<acp.InitializeResponse> => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "Flamecast", version: "2.0.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            audio: false,
            embeddedContext: false,
            image: false,
          },
          mcpCapabilities: {
            http: false,
            sse: false,
          },
          sessionCapabilities: {
            close: {},
            list: {},
          },
        },
      }),

      newSession: async (params: acp.NewSessionRequest) =>
        this.createAcpSession(agentId, requireTransportSessionId(), params),

      loadSession: async (params: acp.LoadSessionRequest) =>
        this.loadAcpSession(agentId, requireTransportSessionId(), params),

      listSessions: async (params: acp.ListSessionsRequest) =>
        this.listAcpSessions(agentId, params),

      prompt: async (params: acp.PromptRequest) =>
        this.promptAcpSession(agentId, requireTransportSessionId(), params),

      cancel: async (params: acp.CancelNotification) => this.cancelAcpSession(agentId, params),
      unstable_closeSession: async (params: acp.CloseSessionRequest) =>
        this.closeAcpSession(agentId, params),

      authenticate: async () => ({}),
      setSessionMode: async (_params: acp.SetSessionModeRequest) =>
        methodNotSupported("session/set_mode"),
      setSessionConfigOption: async (_params: acp.SetSessionConfigOptionRequest) =>
        methodNotSupported("session/set_config_option"),
      unstable_forkSession: async (_params: acp.ForkSessionRequest) =>
        methodNotSupported("session/fork"),
      unstable_resumeSession: async (_params: acp.ResumeSessionRequest) =>
        methodNotSupported("session/resume"),
      unstable_setSessionModel: async (_params: acp.SetSessionModelRequest) =>
        methodNotSupported("session/set_model"),
      extMethod: async (method: string) => methodNotSupported(method),
      extNotification: async () => undefined,
    };
  }

  private async createManagedSession(
    agentId: string,
    params: acp.NewSessionRequest,
    transportSessionId?: string,
  ): Promise<acp.NewSessionResponse> {
    if (params.mcpServers.length > 0) {
      throw acp.RequestError.invalidParams(undefined, "mcpServers must be empty");
    }

    const managed = this.resolveManagedAgent(agentId);
    const cwd = await realpath(resolve(params.cwd));
    const startedAt = new Date().toISOString();
    const startupLogs: SessionLog[] = [
      this.createRpcLog(acp.AGENT_METHODS.session_new, "client_to_agent", "request", {
        cwd,
        mcpServers: [],
      }),
    ];

    let response: acp.NewSessionResponse;
    try {
      response = await managed.connection.newSession({ cwd, mcpServers: [] });
    } catch (error) {
      throw withTransportFailureContext(error, managed.transport, "Failed to create ACP session");
    }
    startupLogs.push(
      this.createRpcLog(acp.AGENT_METHODS.session_new, "agent_to_client", "response", response),
    );

    const pendingBootstrap = this.pendingSessionBootstraps.get(response.sessionId) ?? null;
    const now = new Date().toISOString();
    await this.requireStorage().createSession({
      id: response.sessionId,
      agentId,
      agentName: managed.agentName,
      spawn: managed.spawn,
      cwd,
      startedAt,
      lastUpdatedAt: pendingBootstrap?.lastUpdatedAt ?? now,
      pendingPermission: pendingBootstrap?.pendingPermission ?? null,
    });

    this.sessionToAgentId.set(response.sessionId, agentId);

    for (const log of startupLogs) {
      await this.requireStorage().appendLog(response.sessionId, log);
    }

    if (pendingBootstrap) {
      for (const log of pendingBootstrap.logs) {
        await this.requireStorage().appendLog(response.sessionId, log);
      }
      this.pendingSessionBootstraps.delete(response.sessionId);
    }

    await this.recordAgentSessionCreation(agentId, response.sessionId, now);

    this.runtimes.set(response.sessionId, {
      id: response.sessionId,
      workspaceRoot: cwd,
      transport: managed.transport,
      terminate: async () => {
        await this.closeManagedSession(agentId, response.sessionId);
      },
      runtime: {
        connection: {
          prompt: async (prompt) => this.promptManagedSession(agentId, response.sessionId, prompt),
        },
        sessionTextChunkLogBuffer: null,
      },
    });

    if (transportSessionId) {
      this.attachSession(response.sessionId, transportSessionId);
    }

    if (pendingBootstrap?.pendingPermission) {
      await this.replayPendingPermission(response.sessionId);
    }

    return response;
  }

  private async createAcpSession(
    agentId: string,
    transportSessionId: string,
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    return this.createManagedSession(agentId, params, transportSessionId);
  }

  private async closeAcpSession(
    agentId: string,
    params: acp.CloseSessionRequest,
  ): Promise<acp.CloseSessionResponse> {
    await this.closeManagedSession(agentId, params.sessionId);
    return {};
  }

  private async listAcpSessions(
    agentId: string,
    params: acp.ListSessionsRequest,
  ): Promise<acp.ListSessionsResponse> {
    let sessions = await this.requireStorage().listSessionsByAgent(agentId);
    if (params.cwd) {
      const cwd = await realpath(resolve(params.cwd));
      sessions = sessions.filter((session) => session.cwd === cwd);
    }

    return {
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        title: session.agentName,
        updatedAt: session.lastUpdatedAt,
      })),
      nextCursor: null,
    };
  }

  private async loadAcpSession(
    agentId: string,
    transportSessionId: string,
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    if (params.mcpServers.length > 0) {
      throw acp.RequestError.invalidParams(undefined, "mcpServers must be empty");
    }

    const session = await this.getSessionMetaForAgent(agentId, params.sessionId);
    const cwd = await realpath(resolve(params.cwd));
    if (cwd !== session.cwd) {
      throw acp.RequestError.invalidParams(undefined, "cwd does not match the stored session");
    }

    this.attachSession(session.id, transportSessionId);
    await this.replayPendingPermission(session.id);
    return {};
  }

  private async promptAcpSession(
    agentId: string,
    transportSessionId: string,
    params: acp.PromptRequest,
  ): Promise<acp.PromptResponse> {
    this.attachSession(params.sessionId, transportSessionId);
    return this.promptManagedSession(agentId, params.sessionId, params);
  }

  private async promptManagedSession(
    agentId: string,
    sessionId: string,
    params: acp.PromptRequest,
  ): Promise<acp.PromptResponse> {
    const managed = this.resolveManagedAgent(agentId);
    await this.getSessionMetaForAgent(agentId, sessionId);

    await this.appendRpcLogForSession(
      sessionId,
      acp.AGENT_METHODS.session_prompt,
      "client_to_agent",
      "request",
      params,
    );

    try {
      const result = await managed.connection.prompt(params);
      await this.flushAgentSessionTextChunkLogBuffer(managed, sessionId);
      await this.appendRpcLogForSession(
        sessionId,
        acp.AGENT_METHODS.session_prompt,
        "agent_to_client",
        "response",
        result,
      );
      return result;
    } catch (error) {
      await this.flushAgentSessionTextChunkLogBuffer(managed, sessionId);
      throw error;
    }
  }

  private async cancelAcpSession(agentId: string, params: acp.CancelNotification): Promise<void> {
    const managed = this.resolveManagedAgent(agentId);
    await this.getSessionMetaForAgent(agentId, params.sessionId);

    const pending = await this.takePendingPermissionResolution(
      params.sessionId,
      undefined,
      true,
    ).catch(() => null);
    if (pending) {
      await this.logPermissionCancelled(params.sessionId, pending);
      await Promise.resolve(pending.resolve({ outcome: { outcome: "cancelled" } }));
    }

    await managed.connection.cancel(params);
  }

  private async closeManagedSession(agentId: string, sessionId: string): Promise<void> {
    const managed = this.resolveManagedAgent(agentId);
    await this.getSessionMetaForAgent(agentId, sessionId);

    const pending = await this.takePendingPermissionResolution(sessionId, undefined, true).catch(
      () => null,
    );
    if (pending) {
      await this.logPermissionCancelled(sessionId, pending);
      await Promise.resolve(pending.resolve({ outcome: { outcome: "cancelled" } }));
    }

    await this.flushAgentSessionTextChunkLogBuffer(managed, sessionId);
    try {
      await managed.connection.unstable_closeSession({ sessionId });
    } catch (error) {
      if (!isSessionCloseUnsupported(error)) {
        throw error;
      }
    }

    this.detachSession(sessionId);
    this.runtimes.delete(sessionId);
    this.sessionToAgentId.delete(sessionId);
    this.pendingSessionBootstraps.delete(sessionId);
    await this.requireStorage().finalizeSession(sessionId, "terminated");
    await this.syncAgentSessionState(agentId);
  }

  private getPendingSessionBootstrap(
    sessionId: string,
    agentId: string,
  ): PendingSessionBootstrapState {
    const existing = this.pendingSessionBootstraps.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: PendingSessionBootstrapState = {
      agentId,
      logs: [],
      pendingPermission: null,
      lastUpdatedAt: null,
    };
    this.pendingSessionBootstraps.set(sessionId, created);
    return created;
  }

  private resolveAttachedConnection(sessionId: string): acp.AgentSideConnection | null {
    const agentId = this.sessionToAgentId.get(sessionId);
    const transportSessionId = this.sessionAttachments.get(sessionId);
    if (!agentId || !transportSessionId) return null;
    return this.upstreamContexts.get(agentId)?.get(transportSessionId)?.connection ?? null;
  }

  private attachSession(sessionId: string, transportSessionId: string): void {
    const agentId = this.sessionToAgentId.get(sessionId);
    if (!agentId) return;

    const nextContext = this.upstreamContexts.get(agentId)?.get(transportSessionId);
    if (!nextContext) return;

    const previousTransportSessionId = this.sessionAttachments.get(sessionId);
    if (previousTransportSessionId) {
      const previousContext = this.upstreamContexts.get(agentId)?.get(previousTransportSessionId);
      previousContext?.attachedSessionIds.delete(sessionId);
    }

    this.sessionAttachments.set(sessionId, transportSessionId);
    nextContext.attachedSessionIds.add(sessionId);
  }

  private detachSession(sessionId: string): void {
    const agentId = this.sessionToAgentId.get(sessionId);
    const transportSessionId = this.sessionAttachments.get(sessionId);
    if (agentId && transportSessionId) {
      this.upstreamContexts
        .get(agentId)
        ?.get(transportSessionId)
        ?.attachedSessionIds.delete(sessionId);
    }
    this.sessionAttachments.delete(sessionId);
  }

  private isInitializeMessage(value: unknown): boolean {
    const messages = parseServerInboundAcpMessages(value);
    return messages?.length === 1 && isInitializeRequest(messages[0]);
  }

  private isAllowedAcpOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) {
      return true;
    }

    try {
      const originUrl = new URL(origin);
      const requestUrl = new URL(request.url);

      if (originUrl.origin === requestUrl.origin) {
        return true;
      }

      return (
        originUrl.protocol === requestUrl.protocol &&
        isLoopbackHostname(originUrl.hostname) &&
        isLoopbackHostname(requestUrl.hostname)
      );
    } catch {
      return false;
    }
  }

  private async stopRuntime(runtime: StartedRuntime): Promise<void> {
    await runtime.terminate().catch(async () => {
      await runtime.transport?.dispose?.().catch(() => undefined);
    });
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
