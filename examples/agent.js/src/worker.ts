import { jsonSchema, stepCountIs, tool } from "ai";
import {
  Agent,
  getAgentByName,
  type AgentContext,
  type Connection,
  type ConnectionContext,
} from "agents";
import { buildDynamicWorkerCode, hashText } from "./dynamic-worker-code.js";
import { generateGatewayText, streamGatewayText } from "./gateway-model.js";
import { prepareExecuteJsSource } from "./repl-source.js";
import {
  COMPACTION_PROMPT,
  DEFAULT_ASSISTANT_REPLY,
  EXECUTE_JS_INPUT_SCHEMA,
  EXECUTE_JS_TOOL_DESCRIPTION,
} from "./prompts.js";
import { serializeTranscript, shouldCompactSession } from "./compaction.js";

const SESSION_BASE_PATH = "/sessions";
const SESSION_PROMPT_METHOD = "session/prompt";
const SESSION_UPDATE_METHOD = "session/update";

type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool_call"; code: string }
  | { role: "tool_result"; result: unknown; logs: string[]; error: { message: string } | null };

type SessionState = {
  cwd: string | null;
  scope: Record<string, unknown>;
  summary: string;
  transcript: TranscriptEntry[];
};

type SessionClient = {
  sessionUpdate(params: { sessionId: string; update: unknown }): Promise<void>;
};

type AgentNamespace = Parameters<typeof getAgentByName>[0];

type AgentEnv = Record<string, unknown> & {
  AGENT_MODE?: string;
  KEEP_RECENT_TURNS?: string;
  MAX_CONTEXT_TOKENS?: string;
  COMPACT_AT_CONTEXT_RATIO?: string;
  CF_ACCOUNT_ID?: string;
  CF_AI_GATEWAY?: string;
  CF_AI_GATEWAY_TOKEN?: string;
  CF_AI_MODEL?: string;
  OPENAI_API_KEY?: string;
  LOADER?: {
    get(
      key: string,
      builder: () => unknown | Promise<unknown>,
    ): { getEntrypoint(): { fetch(url: string, init: RequestInit): Promise<Response> } };
  };
  AcpSessionAgent: AgentNamespace;
};

type PromptRequest = {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
};

type SessionHostPromptResult = { stopReason: "end_turn" | "cancelled" };

function createSessionState(): SessionState {
  return {
    cwd: null,
    scope: {},
    summary: "",
    transcript: [],
  };
}

function cloneSession(session: SessionState): SessionState {
  return structuredClone(session);
}

function getSessionHostMatch(pathname) {
  if (!pathname.startsWith(`${SESSION_BASE_PATH}/`)) {
    return null;
  }

  const remainder = pathname.slice(SESSION_BASE_PATH.length + 1);
  const [encodedSessionId, ...resource] = remainder.split("/");
  if (!encodedSessionId) {
    return null;
  }

  return {
    sessionId: decodeURIComponent(encodedSessionId),
    resource,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function parseStartBody(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid start request");
  }

  const args = value.args;
  if (
    typeof value.command !== "string" ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string") ||
    typeof value.workspace !== "string"
  ) {
    throw new Error("Invalid start request");
  }

  return {
    command: value.command,
    args,
    workspace: value.workspace,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    setup: typeof value.setup === "string" ? value.setup : undefined,
    callbackUrl: typeof value.callbackUrl === "string" ? value.callbackUrl : undefined,
  };
}

function parsePromptBody(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid prompt request");
  }

  return {
    text: typeof value.text === "string" ? value.text : undefined,
  };
}

function parsePermissionBody(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid permission response");
  }

  return {
    optionId: typeof value.optionId === "string" ? value.optionId : undefined,
    outcome: value.outcome === "cancelled" ? value.outcome : undefined,
  };
}

function parseWsControlMessage(value) {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new Error("Invalid control message");
  }

  const queueId = typeof value.queueId === "string" ? value.queueId : undefined;

  switch (value.action) {
    case "prompt":
      if (typeof value.text !== "string") {
        throw new Error("Invalid control message");
      }
      return { action: "prompt", text: value.text };
    case "permission.respond":
      if (
        typeof value.requestId !== "string" ||
        !isRecord(value.body) ||
        !("optionId" in value.body || value.body.outcome === "cancelled")
      ) {
        throw new Error("Invalid control message");
      }
      return {
        action: "permission.respond",
        requestId: value.requestId,
        body:
          typeof value.body.optionId === "string"
            ? { optionId: value.body.optionId }
            : { outcome: "cancelled" },
      };
    case "cancel":
      return queueId ? { action: "cancel", queueId } : { action: "cancel" };
    case "terminate":
      return { action: "terminate" };
    case "ping":
      return { action: "ping" };
    case "queue.clear":
      return { action: "queue.clear" };
    case "queue.pause":
      return { action: "queue.pause" };
    case "queue.resume":
      return { action: "queue.resume" };
    case "queue.reorder":
      if (!Array.isArray(value.order) || value.order.some((item) => typeof item !== "string")) {
        throw new Error("Invalid control message");
      }
      return { action: "queue.reorder", order: value.order };
    default:
      throw new Error("Invalid control message");
  }
}

function getTextPrompt(params) {
  const first = params.prompt?.find((entry) => entry.type === "text");
  return first?.text ?? "";
}

function splitText(text) {
  return text.match(/\s*\S+\s*/g) ?? [text];
}

function jsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

function truncate(text, maxChars = 1200) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function planScriptedTurn(text) {
  const normalized = text.toLowerCase();
  const tmpFsRequest =
    normalized.includes("node:fs") ||
    normalized.includes("virtual fs") ||
    normalized.includes("/tmp") ||
    normalized.includes("tmp file");

  if (tmpFsRequest) {
    return {
      executeJS: [
        'const { writeFileSync, readFileSync } = await import("node:fs");',
        'writeFileSync("/tmp/hello.txt", "Hello from executeJS");',
        'return { path: "/tmp/hello.txt", contents: readFileSync("/tmp/hello.txt", "utf8") };',
      ].join("\n"),
    };
  }

  const counterRequest = normalized.includes("counter") || normalized.includes("increment");
  if (counterRequest) {
    return {
      executeJS: [
        'counter = typeof counter === "number" ? counter : 0;',
        "counter += 1;",
        "return { counter };",
      ].join("\n"),
    };
  }

  const setMatch = text.match(/set\s+([A-Za-z_$][\w$]*)\s+to\s+(.+)/i);
  if (setMatch) {
    const [, name, rawValue] = setMatch;
    let parsed = rawValue.trim();
    try {
      parsed = JSON.parse(parsed);
    } catch {}

    return {
      executeJS: `${name} = ${JSON.stringify(parsed)};\nreturn { ${name} };`,
    };
  }

  const getMatch = text.match(/(?:show|get|what is)\s+([A-Za-z_$][\w$]*)/i);
  if (getMatch) {
    const [, name] = getMatch;
    return {
      executeJS: `return { ${name}: typeof ${name} === "undefined" ? null : ${name} };`,
    };
  }

  return {
    assistant: DEFAULT_ASSISTANT_REPLY,
  };
}

async function summarizeForCompaction(env, entries, signal) {
  const fallback = entries
    .map((entry) => {
      if (entry.role === "user" || entry.role === "assistant") {
        return `${entry.role}: ${entry.text}`;
      }
      if (entry.role === "tool_call") {
        return `tool call: ${truncate(entry.code, 240)}`;
      }
      return `tool result: ${truncate(jsonStringify(entry.result ?? entry.error ?? null), 240)}`;
    })
    .join("\n");

  if ((env.AGENT_MODE ?? "scripted") === "scripted") {
    return truncate(fallback, 1200);
  }

  const text = await generateGatewayText(env, {
    abortSignal: signal,
    prompt: `${COMPACTION_PROMPT}\n\n${fallback}`,
  });
  if (!text) {
    return truncate(fallback, 1200);
  }

  return truncate(text.trim(), 1200);
}

async function compactSessionIfNeeded(env, session, signal) {
  const keepRecentTurns = Number(env.KEEP_RECENT_TURNS ?? "6");
  if (!shouldCompactSession(env, session)) {
    return;
  }

  const older = session.transcript.slice(0, -keepRecentTurns);
  const recent = session.transcript.slice(-keepRecentTurns);
  session.summary = [session.summary, await summarizeForCompaction(env, older, signal)]
    .filter(Boolean)
    .join("\n");
  session.transcript = recent;
}

async function executeWithDynamicWorker(env, source, scope) {
  const dynamicWorker = env.LOADER.get(`executejs:${await hashText(source)}`, async () =>
    buildDynamicWorkerCode(source),
  );

  const response = await dynamicWorker.getEntrypoint().fetch("https://worker.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonStringify({ scope }),
  });

  return response.json();
}

async function runExecuteJS(env, code, session) {
  const source = prepareExecuteJsSource(code);
  if (env.LOADER) {
    return executeWithDynamicWorker(env, source, session.scope);
  }
  throw new Error("executeJS requires a Dynamic Worker loader binding");
}

function toErrorData(error) {
  if (error && typeof error === "object" && "message" in error) {
    return { message: String(error.message) };
  }
  return { message: String(error) };
}

function toExecutionResult(execution, fallbackScope = {}) {
  const ok = execution?.ok !== false;
  return {
    ok,
    result: execution?.result ?? null,
    logs: Array.isArray(execution?.logs) ? execution.logs.map((entry) => String(entry)) : [],
    error: ok ? null : (execution?.error ?? { message: "Unknown executeJS failure" }),
    scope: execution?.scope ?? fallbackScope,
    scopeKeys: Object.keys(execution?.scope ?? fallbackScope),
  };
}

function toolUpdateContent(logs) {
  return logs.map((text) => ({
    type: "content",
    content: { type: "text", text },
  }));
}

function lastToolResult(session) {
  for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
    const entry = session.transcript[index];
    if (entry.role === "tool_result") {
      return entry;
    }
  }

  return null;
}

function fallbackToolReply(toolResult) {
  if (!toolResult) {
    return "Done.";
  }
  if (toolResult.error) {
    return `executeJS failed: ${toolResult.error.message}`;
  }
  return `Done. ${truncate(jsonStringify(toolResult.result ?? null), 240)}`;
}

async function streamGatewayReply(agent, connection, sessionId, session, signal) {
  const result = await streamGatewayText(agent.env, {
    abortSignal: signal,
    prompt: serializeTranscript(session),
    stopWhen: stepCountIs(5),
    tools: {
      executeJS: tool({
        description: EXECUTE_JS_TOOL_DESCRIPTION,
        inputSchema: jsonSchema(EXECUTE_JS_INPUT_SCHEMA),
        execute: async ({ code }) => {
          const rawExecution = await runExecuteJS(agent.env, String(code), session).catch(
            (error) => ({
              ok: false,
              result: null,
              logs: [],
              error: toErrorData(error),
              scope: session.scope,
            }),
          );
          const execution = toExecutionResult(rawExecution, session.scope);

          session.scope = execution.scope;
          session.transcript.push({
            role: "tool_result",
            result: execution.result,
            logs: execution.logs,
            error: execution.error,
          });
          agent.setState(session);

          return {
            ok: execution.ok,
            result: execution.result,
            logs: execution.logs,
            error: execution.error,
            scopeKeys: execution.scopeKeys,
          };
        },
      }),
    },
    experimental_onToolCallStart: async ({ toolCall }) => {
      if (toolCall.toolName !== "executeJS") {
        return;
      }

      const code =
        toolCall.input && typeof toolCall.input === "object" && "code" in toolCall.input
          ? String(toolCall.input.code ?? "")
          : "";

      session.transcript.push({ role: "tool_call", code });
      agent.setState(session);

      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: toolCall.toolCallId,
          title: "executeJS",
          kind: "execute",
          status: "pending",
          rawInput: { code },
        },
      });

      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: toolCall.toolCallId,
          status: "in_progress",
        },
      });
    },
    experimental_onToolCallFinish: async ({ toolCall, success, output, error }) => {
      if (toolCall.toolName !== "executeJS") {
        return;
      }

      const execution = success
        ? toExecutionResult(output, session.scope)
        : toExecutionResult(
            {
              ok: false,
              result: null,
              logs: [],
              error: toErrorData(error),
              scope: session.scope,
            },
            session.scope,
          );

      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: toolCall.toolCallId,
          status: execution.ok ? "completed" : "failed",
          content: toolUpdateContent(execution.logs),
          rawOutput: {
            result: execution.result,
            error: execution.error,
            scopeKeys: execution.scopeKeys,
          },
        },
      });
    },
  });

  if (!result) {
    return null;
  }

  let assistant = "";
  for await (const chunk of result.textStream) {
    if (!chunk) {
      continue;
    }

    assistant += chunk;
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      },
    });
  }

  return assistant.trim() || fallbackToolReply(lastToolResult(session));
}

async function streamText(connection, sessionId, text) {
  for (const chunk of splitText(text)) {
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      },
    });
  }
}

async function promptSession(
  agent: AcpSessionAgent,
  connection: SessionClient,
  sessionId: string,
  params: PromptRequest,
): Promise<SessionHostPromptResult> {
  agent.pendingPrompt?.abort();
  agent.pendingPrompt = new AbortController();
  const { signal } = agent.pendingPrompt;
  const userText = getTextPrompt(params);
  const session = cloneSession(agent.state);

  try {
    await compactSessionIfNeeded(agent.env, session, signal);
    session.transcript.push({ role: "user", text: userText });
    agent.setState(session);

    const mode = agent.env.AGENT_MODE ?? "scripted";
    if (mode !== "scripted") {
      const assistant = await streamGatewayReply(agent, connection, sessionId, session, signal);
      if (signal.aborted) {
        return { stopReason: "cancelled" };
      }
      if (assistant) {
        session.transcript.push({ role: "assistant", text: assistant });
        agent.setState(session);
        return { stopReason: "end_turn" };
      }
    }

    const plan = planScriptedTurn(userText);

    if (signal.aborted) {
      return { stopReason: "cancelled" };
    }

    if (!plan.executeJS) {
      const assistant = String(plan.assistant ?? "Done.");
      session.transcript.push({ role: "assistant", text: assistant });
      agent.setState(session);
      await streamText(connection, sessionId, assistant);
      return { stopReason: "end_turn" };
    }

    const toolCallId = crypto.randomUUID();
    const code = String(plan.executeJS);
    session.transcript.push({ role: "tool_call", code });
    agent.setState(session);

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "executeJS",
        kind: "execute",
        status: "pending",
        rawInput: { code },
      },
    });

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
      },
    });

    const execution = await runExecuteJS(agent.env, code, session);
    session.scope = execution.scope ?? {};
    session.transcript.push({
      role: "tool_result",
      result: execution.result ?? null,
      logs: execution.logs ?? [],
      error: execution.ok ? null : (execution.error ?? { message: "Unknown executeJS failure" }),
    });
    agent.setState(session);

    const content = (execution.logs ?? []).map((text) => ({
      type: "content",
      content: { type: "text", text },
    }));

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: execution.ok ? "completed" : "failed",
        content,
        rawOutput: {
          result: execution.result ?? null,
          error: execution.ok ? null : (execution.error ?? null),
          scopeKeys: Object.keys(session.scope),
        },
      },
    });

    const assistant = execution.ok
      ? `executeJS completed. ${truncate(jsonStringify(execution.result ?? null), 240)}`
      : `executeJS failed: ${execution.error?.message ?? "Unknown error"}`;

    session.transcript.push({ role: "assistant", text: assistant });
    agent.setState(session);
    await streamText(connection, sessionId, assistant);
    return { stopReason: "end_turn" };
  } catch (error) {
    if (signal.aborted) {
      return { stopReason: "cancelled" };
    }
    throw error;
  } finally {
    agent.pendingPrompt = null;
  }
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
      return Response.json({
        root: "/",
        entries: [],
        truncated: false,
        maxEntries: 0,
      });
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

    let body;
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
          message: error instanceof Error ? error.message : "Command failed",
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
        { error: error instanceof Error ? error.message : "Failed to start session" },
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
      return Response.json(
        { error: error instanceof Error ? error.message : "Prompt failed" },
        { status: 500 },
      );
    }
  }

  handleSessionHostQueue() {
    if (this.state.cwd === null) {
      return Response.json({ error: `Session "${this.name}" not found` }, { status: 404 });
    }

    return Response.json({
      processing: Boolean(this.pendingPrompt),
      paused: false,
      items: [],
      size: 0,
    });
  }

  async handleSessionHostPermission(requestId: string, request: Request) {
    parsePermissionBody(JSON.parse(await request.text()));
    return Response.json({ error: `Permission request "${requestId}" not found` }, { status: 404 });
  }

  async executeSessionHostPrompt(text: string): Promise<SessionHostPromptResult> {
    const params: PromptRequest = {
      sessionId: this.name,
      prompt: [{ type: "text", text } as const],
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
        message: error instanceof Error ? error.message : "Prompt failed",
      });
      throw error;
    }
  }

  async handleSessionHostControl(message: ReturnType<typeof parseWsControlMessage>) {
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
