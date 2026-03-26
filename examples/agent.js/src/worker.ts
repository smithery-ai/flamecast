import {
  Agent,
  getAgentByName,
  type AgentContext,
  type Connection,
  type ConnectionContext,
} from "agents";
import { promptSession } from "./session-prompt.js";
import {
  SESSION_BASE_PATH,
  SESSION_PROMPT_METHOD,
  SESSION_UPDATE_METHOD,
  createSessionState,
  cloneSession,
  getSessionHostMatch,
  parsePermissionBody,
  parsePromptBody,
  parseStartBody,
  parseWsControlMessage,
  type PromptRequest,
  type PromptEnv,
  type SessionHostControlMessage,
  type SessionHostPromptResult,
  type SessionState,
} from "./session-protocol.js";

type AgentNamespace = Parameters<typeof getAgentByName>[0];

type AgentEnv = PromptEnv & {
  AcpSessionAgent: AgentNamespace;
};

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function createFsSnapshotResponse() {
  return Response.json({
    root: "/",
    entries: [],
    truncated: false,
    maxEntries: 0,
  });
}

function createQueueResponse(processing: boolean) {
  return Response.json({
    processing,
    paused: false,
    items: [],
    size: 0,
  });
}

export class AcpSessionAgent extends Agent<AgentEnv, SessionState> {
  static options = {
    sendIdentityOnConnect: false,
  };

  declare env: AgentEnv;
  pendingPrompt: AbortController | null = null;
  sessionConnections = new Map<string, Connection>();
  initialState: SessionState = createSessionState();

  constructor(ctx: AgentContext, env: AgentEnv) {
    super(ctx, env);
  }

  shouldSendProtocolMessages() {
    return false;
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);
    const match = getSessionHostMatch(url.pathname);
    if (!match || match.sessionId !== this.name) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const [resource = "", secondary = ""] = match.resource;

    if (resource === "start" && request.method === "POST") {
      return this.handleSessionHostStart(request);
    }
    if (resource === "terminate" && request.method === "POST") {
      return this.handleSessionHostTerminate();
    }
    if (resource === "prompt" && request.method === "POST") {
      return this.handleSessionHostPrompt(request);
    }
    if (resource === "queue" && request.method === "GET") {
      return this.handleSessionHostQueue();
    }
    if (resource === "permissions" && secondary && request.method === "POST") {
      return this.handleSessionHostPermission(decodeURIComponent(secondary), request);
    }
    if (resource === "fs" && secondary === "snapshot" && request.method === "GET") {
      return createFsSnapshotResponse();
    }
    if (resource === "files" && request.method === "GET") {
      return Response.json(
        { error: "File preview is not supported by agent.js runtime" },
        { status: 404 },
      );
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const pathname = new URL(ctx.request.url).pathname;
    const sessionMatch = getSessionHostMatch(pathname);
    if (sessionMatch?.sessionId === this.name && sessionMatch.resource.length === 0) {
      this.sessionConnections.set(connection.id, connection);
      connection.send(JSON.stringify({ type: "connected", sessionId: this.name }));
      return;
    }

    connection.close(1008, "Missing session ID");
  }

  async onMessage(connection: Connection, message: unknown) {
    if (!this.sessionConnections.has(connection.id)) {
      return;
    }

    let body: SessionHostControlMessage;
    try {
      body = parseWsControlMessage(JSON.parse(String(message)));
    } catch {
      connection.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    try {
      await this.handleSessionHostControl(body);
    } catch (error) {
      connection.send(
        JSON.stringify({
          type: "error",
          message: toErrorMessage(error, "Command failed"),
        }),
      );
    }
  }

  onClose(connection: Connection) {
    this.sessionConnections.delete(connection.id);
  }

  onError(error: unknown): void;
  onError(connection: Connection, error: unknown): void;
  onError(connectionOrError: Connection | unknown, error?: unknown) {
    if (error === undefined) {
      return;
    }
    if (
      !connectionOrError ||
      typeof connectionOrError !== "object" ||
      !("id" in connectionOrError) ||
      typeof connectionOrError.id !== "string"
    ) {
      return;
    }
    this.sessionConnections.delete(connectionOrError.id);
  }

  async handleSessionHostStart(request: Request) {
    if (this.state.cwd !== null) {
      return Response.json({ error: `Session "${this.name}" already exists` }, { status: 409 });
    }

    try {
      const body = parseStartBody(JSON.parse(await request.text()));
      const session = cloneSession(this.state);
      session.cwd = body.workspace;
      this.setState(session);

      const url = new URL(request.url);
      const hostUrl = `${url.origin}${SESSION_BASE_PATH}/${encodeURIComponent(this.name)}`;
      const websocketUrl = hostUrl.replace(/^http(s?):/, "ws$1:");

      return Response.json({
        acpSessionId: this.name,
        hostUrl,
        websocketUrl,
      });
    } catch (error) {
      return Response.json(
        { error: toErrorMessage(error, "Failed to start session") },
        { status: 400 },
      );
    }
  }

  async handleSessionHostTerminate() {
    if (this.state.cwd === null) {
      return Response.json({ error: `Session "${this.name}" not found` }, { status: 404 });
    }

    this.pendingPrompt?.abort();
    this.setState(createSessionState());

    for (const connection of this.sessionConnections.values()) {
      connection.close(1000, "Session terminated");
    }
    this.sessionConnections.clear();

    return Response.json({ ok: true });
  }

  async handleSessionHostPrompt(request: Request) {
    if (this.state.cwd === null) {
      return Response.json({ error: `Session "${this.name}" not found` }, { status: 404 });
    }
    if (this.pendingPrompt) {
      return Response.json({ error: "A prompt is already running" }, { status: 409 });
    }

    try {
      const body = parsePromptBody(JSON.parse(await request.text()));
      if (!body.text) {
        return Response.json({ error: "Missing 'text' field" }, { status: 400 });
      }

      const result = await this.executeSessionHostPrompt(body.text);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: toErrorMessage(error, "Prompt failed") }, { status: 500 });
    }
  }

  handleSessionHostQueue() {
    if (this.state.cwd === null) {
      return Response.json({ error: `Session "${this.name}" not found` }, { status: 404 });
    }

    return createQueueResponse(Boolean(this.pendingPrompt));
  }

  async handleSessionHostPermission(requestId: string, request: Request) {
    parsePermissionBody(JSON.parse(await request.text()));
    return Response.json({ error: `Permission request "${requestId}" not found` }, { status: 404 });
  }

  async executeSessionHostPrompt(text: string): Promise<SessionHostPromptResult> {
    const params: PromptRequest = {
      sessionId: this.name,
      prompt: [{ type: "text", text }],
    };

    this.emitSessionHostRpc(SESSION_PROMPT_METHOD, "client_to_agent", "request", params);

    try {
      const result = await promptSession(
        this,
        {
          sessionUpdate: async (payload) => {
            this.emitSessionHostRpc(
              SESSION_UPDATE_METHOD,
              "agent_to_client",
              "notification",
              payload,
            );
          },
        },
        this.name,
        params,
      );
      this.emitSessionHostRpc(SESSION_PROMPT_METHOD, "agent_to_client", "response", result);
      return result;
    } catch (error) {
      this.broadcastSessionMessage({
        type: "error",
        message: toErrorMessage(error, "Prompt failed"),
      });
      throw error;
    }
  }

  async handleSessionHostControl(message: SessionHostControlMessage) {
    switch (message.action) {
      case "prompt":
        if (this.state.cwd === null) {
          throw new Error(`Session "${this.name}" not found`);
        }
        await this.executeSessionHostPrompt(message.text);
        return;
      case "permission.respond":
        throw new Error(`Permission request "${message.requestId}" not found`);
      case "terminate":
        await this.handleSessionHostTerminate();
        return;
      case "ping":
      case "cancel":
      case "queue.clear":
      case "queue.pause":
      case "queue.resume":
      case "queue.reorder":
        return;
    }
  }

  emitSessionHostEvent(type: string, data: unknown) {
    const timestamp = new Date().toISOString();
    this.broadcastSessionMessage({
      type: "event",
      timestamp,
      event: { type, data, timestamp },
    });
  }

  emitSessionHostRpc(method: string, direction: string, phase: string, payload?: unknown) {
    const data: { method: string; direction: string; phase: string; payload?: unknown } = {
      method,
      direction,
      phase,
    };
    if (payload !== undefined) {
      data.payload = payload;
    }
    this.emitSessionHostEvent("rpc", data);
  }

  broadcastSessionMessage(message: unknown) {
    const data = JSON.stringify(message);
    for (const connection of this.sessionConnections.values()) {
      connection.send(data);
    }
  }
}

export default {
  async fetch(request: Request, env: AgentEnv) {
    const url = new URL(request.url);
    const sessionId = getSessionHostMatch(url.pathname)?.sessionId;

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        mode: env.AGENT_MODE ?? "scripted",
        agentSdk: true,
        dynamicWorkers: Boolean(env.LOADER),
      });
    }

    if (sessionId) {
      const stub = await getAgentByName(env.AcpSessionAgent, sessionId);
      return stub.fetch(request);
    }

    return Response.json(
      {
        name: "flamecast-agent-js",
        endpoints: {
          health: "/health",
          sessionHost: "/sessions/:sessionId",
        },
      },
      { status: url.pathname === SESSION_BASE_PATH ? 400 : 200 },
    );
  },
};
