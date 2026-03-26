import * as acp from "@agentclientprotocol/sdk";

const DEFAULT_MODEL = "openai/gpt-5.2";
const SYSTEM_PROMPT = [
  "You are a JS-first ACP agent.",
  "The only native tool is executeJS.",
  "When you use executeJS, return JSON with a single key named executeJS whose value is JavaScript source.",
  "Code runs in a shared session REPL-like scope and must end with an explicit return.",
  "Keep persisted globals JSON-serializable.",
  "If no tool call is needed, return JSON with a single key named assistant.",
  'Return raw JSON only. Do not wrap it in markdown fences.',
].join("\n");
const FINAL_PROMPT = [
  "You are a JS-first ACP agent.",
  "Write the final assistant reply for the user after executeJS has run.",
  "Be concise and factual.",
].join("\n");
const COMPACTION_PROMPT = [
  "Summarize the older conversation context for a JS-first coding agent.",
  "Keep only durable facts, important intermediate results, and globals the next turn should remember.",
  "Write short bullet lines without markdown fences.",
].join("\n");

function createSession() {
  return {
    pendingPrompt: null,
    scope: {},
    summary: "",
    transcript: [],
  };
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

function rewritePersistentBindings(source) {
  return source
    .replace(
      /(^|\n)(\s*)(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
      "$1$2scope.$4 =",
    )
    .replace(
      /(^|\n)(\s*)async function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      "$1$2scope.$3 = async function $3(",
    )
    .replace(
      /(^|\n)(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      "$1$2scope.$3 = function $3(",
    )
    .replace(/(^|\n)(\s*)class\s+([A-Za-z_$][\w$]*)\s*/g, "$1$2scope.$3 = class $3 ")
    .replace(/\bimport\s*\(/g, "__import__(");
}

function serializeTranscript(session, nextUserText) {
  const parts = [];

  if (session.summary) {
    parts.push(`[Compaction]\n${session.summary}`);
  }

  for (const entry of session.transcript) {
    switch (entry.role) {
      case "user":
        parts.push(`[User]\n${entry.text}`);
        break;
      case "assistant":
        parts.push(`[Assistant]\n${entry.text}`);
        break;
      case "tool_call":
        parts.push(`[Assistant]\n<executeJS>\n${entry.code}`);
        break;
      case "tool_result":
        parts.push(
          `[Tool result]\n${truncate(jsonStringify({
            result: entry.result,
            logs: entry.logs,
            error: entry.error,
          }))}`,
        );
        break;
    }
  }

  parts.push(`[User]\n${nextUserText}`);
  return parts.join("\n\n");
}

function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model response did not contain JSON");
  }
  return JSON.parse(text.slice(start, end + 1));
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
    assistant:
      "I can use executeJS against a shared session scope. Ask me to store a value, fetch data, or compute something.",
  };
}

async function getGatewayModel(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const gateway = env.CF_AI_GATEWAY;
  const token = env.CF_AI_GATEWAY_TOKEN;

  if (!accountId || !gateway || !token) {
    return null;
  }

  const [{ generateText }, { createAiGateway, createUnified }] = await Promise.all([
    import("ai"),
    import("ai-gateway-provider"),
  ]);

  const aiGateway = createAiGateway({
    accountId,
    gateway,
    apiKey: token,
  });

  const unifiedModel = createUnified()(env.CF_AI_MODEL || DEFAULT_MODEL);

  return {
    generateText: (options) =>
      generateText({
        ...options,
        model: aiGateway(unifiedModel),
      }),
  };
}

async function summarizeForCompaction(env, session, entries, signal) {
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

  const model = await getGatewayModel(env);
  if (!model) {
    return truncate(fallback, 1200);
  }

  const { text } = await model.generateText({
    abortSignal: signal,
    prompt: `${COMPACTION_PROMPT}\n\n${fallback}`,
  });

  return truncate(text.trim(), 1200);
}

async function compactSessionIfNeeded(env, session, signal) {
  const compactAt = Number(env.COMPACT_AT_CHARS ?? "12000");
  const keepRecentTurns = Number(env.KEEP_RECENT_TURNS ?? "6");
  const serialized = serializeTranscript(session, "");

  if (serialized.length <= compactAt || session.transcript.length <= keepRecentTurns) {
    return;
  }

  const older = session.transcript.slice(0, -keepRecentTurns);
  const recent = session.transcript.slice(-keepRecentTurns);
  session.summary = [session.summary, await summarizeForCompaction(env, session, older, signal)]
    .filter(Boolean)
    .join("\n");
  session.transcript = recent;
}

async function planGatewayTurn(env, session, userText, signal) {
  const model = await getGatewayModel(env);
  if (!model) {
    return planScriptedTurn(userText);
  }

  const { text } = await model.generateText({
    abortSignal: signal,
    prompt: `${SYSTEM_PROMPT}\n\n${serializeTranscript(session, userText)}`,
  });

  return parseJsonObject(text);
}

async function createFinalGatewayReply(env, session, userText, toolResult, signal) {
  const model = await getGatewayModel(env);
  if (!model) {
    if (toolResult?.error) {
      return `executeJS failed: ${toolResult.error.message}`;
    }
    return `Done. ${truncate(jsonStringify(toolResult?.result ?? null), 240)}`;
  }

  const { text } = await model.generateText({
    abortSignal: signal,
    prompt: [
      FINAL_PROMPT,
      "",
      serializeTranscript(session, userText),
      "",
      `[Tool result]\n${jsonStringify(toolResult)}`,
    ].join("\n"),
  });

  return text.trim();
}

function buildDynamicWorkerSource(source) {
  return `
const SOURCE = ${JSON.stringify(source)};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runner = new AsyncFunction("scope", "__console", "__import__", \`const console = __console;\\nwith (scope) {\\n\${SOURCE}\\n}\`);

function normalizeValue(value, seen = new WeakSet()) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, seen));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = normalizeValue(entry, seen);
    }
    return output;
  }
  return String(value);
}

function formatLogEntry(args) {
  return args.map((value) => {
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(normalizeValue(value));
  }).join(" ");
}

export default {
  async fetch(request) {
    const { scope } = await request.json();
    const logs = [];
    const console = {
      log: (...args) => logs.push(formatLogEntry(args)),
      info: (...args) => logs.push(formatLogEntry(args)),
      warn: (...args) => logs.push(formatLogEntry(args)),
      error: (...args) => logs.push(formatLogEntry(args)),
    };

    try {
      const result = await runner(scope, console, (specifier) => import(specifier));
      return Response.json({
        ok: true,
        result: normalizeValue(result),
        scope: normalizeValue(scope),
        logs,
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: normalizeValue(error),
        scope: normalizeValue(scope),
        logs,
      });
    }
  },
};
`;
}

async function executeWithDynamicWorker(env, source, scope) {
  const dynamicWorker = await env.LOADER.load({
    compatibilityDate: "2026-03-25",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: buildDynamicWorkerSource(source),
  });

  const response = await dynamicWorker.fetch("https://worker.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonStringify({ scope }),
  });

  return response.json();
}

async function executeWithLocalExecutor(env, source, scope) {
  const response = await fetch(env.LOCAL_EXECUTOR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonStringify({ source, scope }),
  });

  return response.json();
}

async function runExecuteJS(env, code, session) {
  const source = rewritePersistentBindings(code);
  if (env.LOADER) {
    return executeWithDynamicWorker(env, source, session.scope);
  }
  if (env.LOCAL_EXECUTOR_URL) {
    return executeWithLocalExecutor(env, source, session.scope);
  }
  throw new Error("executeJS requires either a Dynamic Worker loader or a local executor URL");
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

function toUint8Array(data) {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((value) => new Uint8Array(value));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new TextEncoder().encode(String(data));
}

function createAcpTransport(ws) {
  const output = new ReadableStream({
    start(controller) {
      ws.addEventListener("message", async (event) => {
        controller.enqueue(await toUint8Array(event.data));
      });
      ws.addEventListener("close", () => controller.close());
      ws.addEventListener("error", () => controller.error(new Error("WebSocket error")));
    },
    cancel() {
      ws.close(1000, "ACP transport closed");
    },
  });

  const input = new WritableStream({
    write(chunk) {
      ws.send(chunk);
    },
    close() {
      ws.close(1000, "ACP transport closed");
    },
    abort() {
      ws.close(1011, "ACP transport aborted");
    },
  });

  return { input, output };
}

class DynamicWorkerAgent {
  constructor(connection, env) {
    this.connection = connection;
    this.env = env;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async newSession() {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, createSession());
    return { sessionId };
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();
    const { signal } = session.pendingPrompt;
    const userText = getTextPrompt(params);

    try {
      await compactSessionIfNeeded(this.env, session, signal);
      session.transcript.push({ role: "user", text: userText });

      const mode = this.env.AGENT_MODE ?? "scripted";
      const plan =
        mode === "scripted"
          ? planScriptedTurn(userText)
          : await planGatewayTurn(this.env, session, userText, signal);

      if (signal.aborted) {
        return { stopReason: "cancelled" };
      }

      if (!plan.executeJS) {
        const assistant = String(plan.assistant ?? "Done.");
        session.transcript.push({ role: "assistant", text: assistant });
        await streamText(this.connection, params.sessionId, assistant);
        return { stopReason: "end_turn" };
      }

      const toolCallId = crypto.randomUUID();
      const code = String(plan.executeJS);
      session.transcript.push({ role: "tool_call", code });

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "executeJS",
          kind: "execute",
          status: "pending",
          rawInput: { code },
        },
      });

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
        },
      });

      const execution = await runExecuteJS(this.env, code, session);
      session.scope = execution.scope ?? {};
      session.transcript.push({
        role: "tool_result",
        result: execution.result ?? null,
        logs: execution.logs ?? [],
        error: execution.ok ? null : execution.error ?? { message: "Unknown executeJS failure" },
      });

      const content = (execution.logs ?? []).map((text) => ({
        type: "content",
        content: { type: "text", text },
      }));

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: execution.ok ? "completed" : "failed",
          content,
          rawOutput: {
            result: execution.result ?? null,
            error: execution.ok ? null : execution.error ?? null,
            scopeKeys: Object.keys(session.scope),
          },
        },
      });

      const assistant =
        mode === "scripted"
          ? execution.ok
            ? `executeJS completed. ${truncate(jsonStringify(execution.result ?? null), 240)}`
            : `executeJS failed: ${execution.error?.message ?? "Unknown error"}`
          : await createFinalGatewayReply(this.env, session, userText, execution, signal);

      session.transcript.push({ role: "assistant", text: assistant });
      await streamText(this.connection, params.sessionId, assistant);
      return { stopReason: "end_turn" };
    } catch (error) {
      if (signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      session.pendingPrompt = null;
    }
  }

  async cancel(params) {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        mode: env.AGENT_MODE ?? "scripted",
        dynamicWorkers: Boolean(env.LOADER),
      });
    }

    if (url.pathname !== "/acp") {
      return Response.json(
        {
          name: "flamecast-agent-js",
          endpoints: {
            health: "/health",
            acp: "/acp",
          },
        },
        { status: 200 },
      );
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const transport = createAcpTransport(server);
    new acp.AgentSideConnection(
      (connection) => new DynamicWorkerAgent(connection, env),
      acp.ndJsonStream(transport.input, transport.output),
    );

    return new Response(null, { status: 101, webSocket: client });
  },
};
