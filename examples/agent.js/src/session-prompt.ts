import { jsonSchema, stepCountIs, tool } from "ai";
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
import type {
  PromptEnv,
  PromptRequest,
  SessionClient,
  SessionHostPromptResult,
  SessionState,
  TranscriptEntry,
} from "./session-protocol.js";
import { cloneSession, getTextPrompt } from "./session-protocol.js";

type PromptSessionAgent = {
  env: PromptEnv;
  state: SessionState;
  pendingPrompt: AbortController | null;
  setState(state: SessionState): void;
};

function splitText(text: string) {
  return text.match(/\s*\S+\s*/g) ?? [text];
}

function jsonStringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function truncate(text: string, maxChars = 1200) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function planScriptedTurn(text: string) {
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
    const trimmedValue = rawValue.trim();
    let parsed: unknown = trimmedValue;
    try {
      parsed = JSON.parse(trimmedValue);
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

async function summarizeForCompaction(
  env: PromptEnv,
  entries: TranscriptEntry[],
  signal: AbortSignal,
) {
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

async function compactSessionIfNeeded(env: PromptEnv, session: SessionState, signal: AbortSignal) {
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

async function executeWithDynamicWorker(
  env: PromptEnv,
  source: string,
  scope: Record<string, unknown>,
) {
  const dynamicWorker = env.LOADER?.get(`executejs:${await hashText(source)}`, async () =>
    buildDynamicWorkerCode(source),
  );
  if (!dynamicWorker) {
    throw new Error("executeJS requires a Dynamic Worker loader binding");
  }

  const response = await dynamicWorker.getEntrypoint().fetch("https://worker.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonStringify({ scope }),
  });

  return response.json();
}

async function runExecuteJS(env: PromptEnv, code: string, session: SessionState) {
  const source = prepareExecuteJsSource(code);
  return executeWithDynamicWorker(env, source, session.scope);
}

function toErrorData(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return { message: String(error.message) };
  }
  return { message: String(error) };
}

function toExecutionResult(
  execution:
    | {
        ok?: boolean;
        result?: unknown;
        logs?: unknown;
        error?: { message: string } | null;
        scope?: Record<string, unknown>;
      }
    | null
    | undefined,
  fallbackScope: Record<string, unknown> = {},
) {
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

function toolUpdateContent(logs: string[]) {
  return logs.map((text) => ({
    type: "content",
    content: { type: "text", text },
  }));
}

function lastToolResult(session: SessionState) {
  for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
    const entry = session.transcript[index];
    if (entry.role === "tool_result") {
      return entry;
    }
  }

  return null;
}

function fallbackToolReply(toolResult: Extract<TranscriptEntry, { role: "tool_result" }> | null) {
  if (!toolResult) {
    return "Done.";
  }
  if (toolResult.error) {
    return `executeJS failed: ${toolResult.error.message}`;
  }
  return `Done. ${truncate(jsonStringify(toolResult.result ?? null), 240)}`;
}

async function streamGatewayReply(
  agent: PromptSessionAgent,
  connection: SessionClient,
  sessionId: string,
  session: SessionState,
  signal: AbortSignal,
) {
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
            (error: unknown) => ({
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

async function streamText(connection: SessionClient, sessionId: string, text: string) {
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

export async function promptSession(
  agent: PromptSessionAgent,
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

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: execution.ok ? "completed" : "failed",
        content: toolUpdateContent(execution.logs ?? []),
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
