export const SESSION_BASE_PATH = "/sessions";
export const SESSION_PROMPT_METHOD = "session/prompt";
export const SESSION_UPDATE_METHOD = "session/update";

export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool_call"; code: string }
  | { role: "tool_result"; result: unknown; logs: string[]; error: { message: string } | null };

export type SessionState = {
  cwd: string | null;
  scope: Record<string, unknown>;
  summary: string;
  transcript: TranscriptEntry[];
};

export type SessionClient = {
  sessionUpdate(params: { sessionId: string; update: unknown }): Promise<void>;
};

export type DynamicWorkerLoader = {
  get(
    key: string,
    builder: () => unknown | Promise<unknown>,
  ): { getEntrypoint(): { fetch(url: string, init: RequestInit): Promise<Response> } };
};

export type PromptEnv = Record<string, unknown> & {
  AGENT_MODE?: string;
  KEEP_RECENT_TURNS?: string;
  MAX_CONTEXT_TOKENS?: string;
  COMPACT_AT_CONTEXT_RATIO?: string;
  CF_ACCOUNT_ID?: string;
  CF_AI_GATEWAY?: string;
  CF_AI_GATEWAY_TOKEN?: string;
  CF_AI_MODEL?: string;
  OPENAI_API_KEY?: string;
  LOADER?: DynamicWorkerLoader;
};

export type PromptRequest = {
  sessionId: string;
  prompt: Array<{ type: "text"; text: string }>;
};

export type SessionHostPromptResult = { stopReason: "end_turn" | "cancelled" };

export type SessionHostControlMessage =
  | { action: "prompt"; text: string }
  | {
      action: "permission.respond";
      requestId: string;
      body: { optionId: string } | { outcome: "cancelled" };
    }
  | { action: "cancel"; queueId?: string }
  | { action: "terminate" }
  | { action: "ping" }
  | { action: "queue.clear" }
  | { action: "queue.pause" }
  | { action: "queue.resume" }
  | { action: "queue.reorder"; order: string[] };

export function createSessionState(): SessionState {
  return {
    cwd: null,
    scope: {},
    summary: "",
    transcript: [],
  };
}

export function cloneSession(session: SessionState): SessionState {
  return structuredClone(session);
}

export function getSessionHostMatch(pathname: string) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseStartBody(value: unknown) {
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

export function parsePromptBody(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid prompt request");
  }

  return {
    text: typeof value.text === "string" ? value.text : undefined,
  };
}

export function parsePermissionBody(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid permission response");
  }

  return {
    optionId: typeof value.optionId === "string" ? value.optionId : undefined,
    outcome: value.outcome === "cancelled" ? value.outcome : undefined,
  };
}

export function parseWsControlMessage(value: unknown): SessionHostControlMessage {
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

export function getTextPrompt(params: PromptRequest) {
  const first = params.prompt.find((entry) => entry.type === "text");
  return first?.text ?? "";
}
