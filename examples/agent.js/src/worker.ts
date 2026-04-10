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
  AcpRuntimeHubAgent: AgentNamespace;
  AcpSessionAgent: AgentNamespace;
};

type RuntimeHubConnectionState = {
  subscriptions: string[];
};

type RuntimeHubEvent = {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
};

type RuntimeHubEventBody = {
  sessionId: string;
  agentId: string;
  event: RuntimeHubEvent;
};

type RuntimeHubControlMessage =
  | { action: "subscribe"; channel: string; since?: number }
  | { action: "unsubscribe"; channel: string }
  | { action: "prompt"; sessionId: string; text: string }
  | {
      action: "permission.respond";
      sessionId: string;
      requestId: string;
      body: { optionId: string } | { outcome: "cancelled" };
    }
  | { action: "cancel"; sessionId: string; queueId?: string }
  | { action: "terminate"; sessionId: string }
  | { action: "queue.reorder"; sessionId: string; order: string[] }
  | { action: "queue.clear"; sessionId: string }
  | { action: "queue.pause"; sessionId: string }
  | { action: "queue.resume"; sessionId: string }
  | { action: "ping" }
  | { action: "terminal.create"; sessionId?: string; data?: string; cols?: number; rows?: number }
  | { action: "terminal.input"; terminalId: string; data: string }
  | { action: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { action: "terminal.kill"; terminalId: string };

const JSON_HEADERS = { "content-type": "application/json" };
const MAX_EVENT_LOG_SIZE = 5_000;
const RUNTIME_HUB_NAME = "runtime";

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function channelMatches(subscription: string, eventChannel: string): boolean {
  return subscription === eventChannel || eventChannel.startsWith(subscription + ":");
}

function getSessionChannels(sessionId: string): string[] {
  return [`session:${sessionId}`, `agent:${sessionId}`, "agents"];
}

function getConnectionSubscriptions(connection: Connection): string[] {
  if (!isRecord(connection.state)) {
    return [];
  }

  const subscriptions = connection.state.subscriptions;
  if (!Array.isArray(subscriptions) || subscriptions.some((item) => typeof item !== "string")) {
    return [];
  }

  return subscriptions;
}

function setConnectionSubscriptions(connection: Connection, subscriptions: string[]) {
  connection.setState({ subscriptions } satisfies RuntimeHubConnectionState);
}

function parseRuntimeHubPublishBody(value: unknown): RuntimeHubEventBody {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.agentId !== "string" ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string" ||
    !isRecord(value.event.data) ||
    typeof value.event.timestamp !== "string"
  ) {
    throw new Error("Invalid runtime event");
  }

  return {
    sessionId: value.sessionId,
    agentId: value.agentId,
    event: {
      type: value.event.type,
      data: value.event.data,
      timestamp: value.event.timestamp,
    },
  };
}

function parseRuntimeHubSessionBody(value: unknown): { sessionId: string } {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Invalid runtime session");
  }

  return { sessionId: value.sessionId };
}

function parseRuntimeHubControlMessage(value: unknown): RuntimeHubControlMessage {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new Error("Invalid control message");
  }

  switch (value.action) {
    case "subscribe":
      if (typeof value.channel !== "string") {
        throw new Error("Invalid control message");
      }
      return {
        action: "subscribe",
        channel: value.channel,
        since: typeof value.since === "number" ? value.since : undefined,
      };
    case "unsubscribe":
      if (typeof value.channel !== "string") {
        throw new Error("Invalid control message");
      }
      return { action: "unsubscribe", channel: value.channel };
    case "prompt":
      if (typeof value.sessionId !== "string" || typeof value.text !== "string") {
        throw new Error("Invalid control message");
      }
      return { action: "prompt", sessionId: value.sessionId, text: value.text };
    case "permission.respond":
      if (
        typeof value.sessionId !== "string" ||
        typeof value.requestId !== "string" ||
        !isRecord(value.body) ||
        !("optionId" in value.body || value.body.outcome === "cancelled")
      ) {
        throw new Error("Invalid control message");
      }
      return {
        action: "permission.respond",
        sessionId: value.sessionId,
        requestId: value.requestId,
        body:
          typeof value.body.optionId === "string"
            ? { optionId: value.body.optionId }
            : { outcome: "cancelled" },
      };
    case "cancel":
      if (typeof value.sessionId !== "string") {
        throw new Error("Invalid control message");
      }
      return typeof value.queueId === "string"
        ? { action: "cancel", sessionId: value.sessionId, queueId: value.queueId }
        : { action: "cancel", sessionId: value.sessionId };
    case "terminate":
      if (typeof value.sessionId !== "string") {
        throw new Error("Invalid control message");
      }
      return { action: "terminate", sessionId: value.sessionId };
    case "queue.reorder":
      if (
        typeof value.sessionId !== "string" ||
        !Array.isArray(value.order) ||
        value.order.some((item) => typeof item !== "string")
      ) {
        throw new Error("Invalid control message");
      }
      return { action: "queue.reorder", sessionId: value.sessionId, order: value.order };
    case "queue.clear":
    case "queue.pause":
    case "queue.resume":
      if (typeof value.sessionId !== "string") {
        throw new Error("Invalid control message");
      }
      return { action: value.action, sessionId: value.sessionId };
    case "ping":
      return { action: "ping" };
    case "terminal.create":
      return {
        action: "terminal.create",
        sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
        data: typeof value.data === "string" ? value.data : undefined,
        cols: typeof value.cols === "number" ? value.cols : undefined,
        rows: typeof value.rows === "number" ? value.rows : undefined,
      };
    case "terminal.input":
      if (typeof value.terminalId !== "string" || typeof value.data !== "string") {
        throw new Error("Invalid control message");
      }
      return {
        action: "terminal.input",
        terminalId: value.terminalId,
        data: value.data,
      };
    case "terminal.resize":
      if (
        typeof value.terminalId !== "string" ||
        typeof value.cols !== "number" ||
        typeof value.rows !== "number"
      ) {
        throw new Error("Invalid control message");
      }
      return {
        action: "terminal.resize",
        terminalId: value.terminalId,
        cols: value.cols,
        rows: value.rows,
      };
    case "terminal.kill":
      if (typeof value.terminalId !== "string") {
        throw new Error("Invalid control message");
      }
      return { action: "terminal.kill", terminalId: value.terminalId };
    default:
      throw new Error("Invalid control message");
  }
}

function toSessionControlMessage(
  message: RuntimeHubControlMessage,
): SessionHostControlMessage | null {
  switch (message.action) {
    case "prompt":
      return { action: "prompt", text: message.text };
    case "permission.respond":
      return {
        action: "permission.respond",
        requestId: message.requestId,
        body: message.body,
      };
    case "cancel":
      return message.queueId
        ? { action: "cancel", queueId: message.queueId }
        : { action: "cancel" };
    case "terminate":
      return { action: "terminate" };
    case "queue.reorder":
      return { action: "queue.reorder", order: message.order };
    case "queue.clear":
      return { action: "queue.clear" };
    case "queue.pause":
      return { action: "queue.pause" };
    case "queue.resume":
      return { action: "queue.resume" };
    case "ping":
      return { action: "ping" };
    case "subscribe":
    case "unsubscribe":
    case "terminal.create":
    case "terminal.input":
    case "terminal.resize":
    case "terminal.kill":
      return null;
  }
}

function createRuntimeHostUrls(request: Request) {
  const url = new URL(request.url);
  return {
    hostUrl: url.origin,
    websocketUrl: url.origin.replace(/^http(s?):/, "ws$1:"),
  };
}

async function getRuntimeHubStub(env: AgentEnv) {
  return getAgentByName(env.AcpRuntimeHubAgent, RUNTIME_HUB_NAME);
}

async function publishRuntimeEvent(env: AgentEnv, body: RuntimeHubEventBody) {
  const stub = await getRuntimeHubStub(env);
  const response = await stub.fetch(
    new Request("https://runtime.internal/internal/events", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function resetRuntimeSession(env: AgentEnv, sessionId: string) {
  const stub = await getRuntimeHubStub(env);
  const response = await stub.fetch(
    new Request("https://runtime.internal/internal/session-reset", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId }),
    }),
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export class AcpRuntimeHubAgent extends Agent<AgentEnv> {
  static options = {
    sendIdentityOnConnect: false,
  };

  declare env: AgentEnv;

  constructor(ctx: AgentContext, env: AgentEnv) {
    super(ctx, env);
    void this.sql`
      CREATE TABLE IF NOT EXISTS runtime_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channels TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
  }

  shouldSendProtocolMessages() {
    return false;
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/internal/events" && request.method === "POST") {
      return this.handlePublishEvent(request);
    }

    if (url.pathname === "/internal/session-reset" && request.method === "POST") {
      return this.handleSessionReset(request);
    }

    if (url.pathname === "/") {
      return Response.json({
        name: "flamecast-agent-js runtime hub",
        websocket: "/",
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const pathname = new URL(ctx.request.url).pathname;
    if (pathname !== "/") {
      connection.close(1008, "Missing runtime websocket path");
      return;
    }

    setConnectionSubscriptions(connection, []);
    connection.send(JSON.stringify({ type: "connected", connectionId: connection.id }));
  }

  async onMessage(connection: Connection, message: unknown) {
    let body: RuntimeHubControlMessage;
    try {
      body = parseRuntimeHubControlMessage(JSON.parse(String(message)));
    } catch {
      connection.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    switch (body.action) {
      case "subscribe":
        this.subscribe(connection, body.channel, body.since ?? 0);
        return;
      case "unsubscribe":
        this.unsubscribe(connection, body.channel);
        return;
      case "ping":
        connection.send(JSON.stringify({ type: "pong" }));
        return;
      case "terminal.create":
      case "terminal.input":
      case "terminal.resize":
      case "terminal.kill":
        connection.send(
          JSON.stringify({
            type: "error",
            message: "terminal operations are not supported by agent.js runtime",
            channel: "terminals",
          }),
        );
        return;
      case "prompt":
      case "permission.respond":
      case "cancel":
      case "terminate":
      case "queue.reorder":
      case "queue.clear":
      case "queue.pause":
      case "queue.resume":
        void this.dispatchSessionControl(connection.id, body);
        return;
    }
  }

  private subscribe(connection: Connection, channel: string, since: number) {
    const subscriptions = new Set(getConnectionSubscriptions(connection));
    subscriptions.add(channel);
    setConnectionSubscriptions(connection, [...subscriptions]);

    const rows = this.sql<{ channels: string; payload: string }>`
      SELECT channels, payload
      FROM runtime_events
      WHERE seq > ${since}
      ORDER BY seq ASC
    `;

    for (const row of rows) {
      const channels: unknown = JSON.parse(row.channels);
      if (!Array.isArray(channels) || channels.some((item) => typeof item !== "string")) {
        continue;
      }

      if (channels.some((eventChannel) => channelMatches(channel, eventChannel))) {
        connection.send(row.payload);
      }
    }

    connection.send(JSON.stringify({ type: "subscribed", channel }));
  }

  private unsubscribe(connection: Connection, channel: string) {
    const subscriptions = new Set(getConnectionSubscriptions(connection));
    subscriptions.delete(channel);
    setConnectionSubscriptions(connection, [...subscriptions]);
    connection.send(JSON.stringify({ type: "unsubscribed", channel }));
  }

  private async dispatchSessionControl(connectionId: string, message: RuntimeHubControlMessage) {
    const sessionId = "sessionId" in message ? message.sessionId : undefined;
    const controlMessage = toSessionControlMessage(message);
    if (!sessionId || !controlMessage) {
      return;
    }

    try {
      const stub = await getAgentByName(this.env.AcpSessionAgent, sessionId);
      const response = await stub.fetch(
        new Request(
          `https://runtime.internal${SESSION_BASE_PATH}/${encodeURIComponent(sessionId)}/control`,
          {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(controlMessage),
          },
        ),
      );

      if (response.ok) {
        return;
      }

      const detail = await response.text();
      this.sendError(
        connectionId,
        detail || `Command failed (${response.status})`,
        `session:${sessionId}`,
      );
    } catch (error) {
      this.sendError(connectionId, toErrorMessage(error, "Command failed"), `session:${sessionId}`);
    }
  }

  private sendError(connectionId: string, message: string, channel?: string) {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    const body = channel ? { type: "error", message, channel } : { type: "error", message };
    connection.send(JSON.stringify(body));
  }

  private async handlePublishEvent(request: Request) {
    try {
      const body = parseRuntimeHubPublishBody(JSON.parse(await request.text()));
      const channels = getSessionChannels(body.sessionId);
      void this.sql`
        INSERT INTO runtime_events (session_id, channels, payload)
        VALUES (${body.sessionId}, ${JSON.stringify(channels)}, "")
      `;
      const seqRows = this.sql<{ seq: number }>`
        SELECT last_insert_rowid() AS seq
      `;
      const inserted = seqRows[0];
      if (!inserted) {
        throw new Error("Failed to persist runtime event");
      }

      const payload = JSON.stringify({
        type: "event",
        channel: channels[0],
        sessionId: body.sessionId,
        agentId: body.agentId,
        seq: inserted.seq,
        event: body.event,
      });

      void this.sql`
        UPDATE runtime_events
        SET payload = ${payload}
        WHERE seq = ${inserted.seq}
      `;

      void this.sql`
        DELETE FROM runtime_events
        WHERE seq <= (
          SELECT COALESCE(MAX(seq) - ${MAX_EVENT_LOG_SIZE}, 0)
          FROM runtime_events
        )
      `;

      for (const connection of this.getConnections()) {
        const subscriptions = getConnectionSubscriptions(connection);
        if (
          subscriptions.some((subscription) =>
            channels.some((eventChannel) => channelMatches(subscription, eventChannel)),
          )
        ) {
          connection.send(payload);
        }
      }

      return Response.json({ seq: inserted.seq });
    } catch (error) {
      return Response.json(
        { error: toErrorMessage(error, "Failed to publish runtime event") },
        { status: 400 },
      );
    }
  }

  private async handleSessionReset(request: Request) {
    try {
      const body = parseRuntimeHubSessionBody(JSON.parse(await request.text()));
      void this.sql`
        DELETE FROM runtime_events
        WHERE session_id = ${body.sessionId}
      `;
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json(
        { error: toErrorMessage(error, "Failed to reset runtime session") },
        { status: 400 },
      );
    }
  }
}

export class AcpSessionAgent extends Agent<AgentEnv, SessionState> {
  static options = {
    sendIdentityOnConnect: false,
  };

  declare env: AgentEnv;
  pendingPrompt: AbortController | null = null;
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
    if (resource === "control" && request.method === "POST") {
      return this.handleSessionHostControlRequest(request);
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

  async handleSessionHostStart(request: Request) {
    if (this.state.cwd !== null) {
      return Response.json({ error: `Session "${this.name}" already exists` }, { status: 409 });
    }

    try {
      const body = parseStartBody(JSON.parse(await request.text()));
      const session = cloneSession(this.state);
      session.cwd = body.workspace;
      this.setState(session);
      await resetRuntimeSession(this.env, this.name);

      return Response.json({
        acpSessionId: this.name,
        ...createRuntimeHostUrls(request),
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
    await resetRuntimeSession(this.env, this.name);

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

  async handleSessionHostControlRequest(request: Request) {
    try {
      const body = parseWsControlMessage(JSON.parse(await request.text()));
      const result = await this.handleSessionHostControl(body);
      return Response.json(result ?? { ok: true });
    } catch (error) {
      return Response.json({ error: toErrorMessage(error, "Command failed") }, { status: 500 });
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

    await this.emitSessionHostRpc(SESSION_PROMPT_METHOD, "client_to_agent", "request", params);

    const result = await promptSession(
      this,
      {
        sessionUpdate: async (payload) => {
          await this.emitSessionHostRpc(
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
    await this.emitSessionHostRpc(SESSION_PROMPT_METHOD, "agent_to_client", "response", result);
    return result;
  }

  async handleSessionHostControl(message: SessionHostControlMessage) {
    switch (message.action) {
      case "prompt":
        if (this.state.cwd === null) {
          throw new Error(`Session "${this.name}" not found`);
        }
        return this.executeSessionHostPrompt(message.text);
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

  async emitSessionHostEvent(type: string, data: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    await publishRuntimeEvent(this.env, {
      sessionId: this.name,
      agentId: this.name,
      event: { type, data, timestamp },
    });
  }

  async emitSessionHostRpc(method: string, direction: string, phase: string, payload?: unknown) {
    const data: { method: string; direction: string; phase: string; payload?: unknown } = {
      method,
      direction,
      phase,
    };
    if (payload !== undefined) {
      data.payload = payload;
    }
    await this.emitSessionHostEvent("rpc", data);
  }
}

export default {
  async fetch(request: Request, env: AgentEnv) {
    const url = new URL(request.url);
    const sessionId = getSessionHostMatch(url.pathname)?.sessionId;
    const isWebSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        mode: env.AGENT_MODE ?? "scripted",
        agentSdk: true,
        dynamicWorkers: Boolean(env.LOADER),
      });
    }

    if (isWebSocket && url.pathname === "/") {
      const stub = await getRuntimeHubStub(env);
      return stub.fetch(request);
    }

    if (sessionId) {
      if (isWebSocket) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      const stub = await getAgentByName(env.AcpSessionAgent, sessionId);
      return stub.fetch(request);
    }

    return Response.json(
      {
        name: "flamecast-agent-js",
        endpoints: {
          health: "/health",
          sessionHost: "/sessions/:sessionId",
          websocket: "/",
        },
      },
      { status: url.pathname === SESSION_BASE_PATH ? 400 : 200 },
    );
  },
};
