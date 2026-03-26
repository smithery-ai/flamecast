export const EXECUTE_JS_TOOL_DESCRIPTION = [
  "Execute JavaScript inside a Cloudflare Worker shared session scope.",
  "Use this tool whenever you need computation, persistent session state, outbound HTTP(S) requests via fetch, or the Worker virtual filesystem via await import('node:fs').",
  "You may call executeJS multiple times in the same turn until you have enough information to answer.",
  "The runtime is REPL-like: a final expression is returned automatically, and you can still use an explicit return when you want to.",
  "Use ordinary globals like `customer = ...` to persist JSON-serializable values across turns.",
  "Do not claim network access is blocked or unavailable unless an actual fetch call fails.",
].join(" ");

export const EXECUTE_JS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description:
        "JavaScript source to execute in the shared session scope. It can use fetch for external web access and await import('node:fs') for the Worker virtual filesystem. A final expression is returned automatically, like a REPL.",
    },
  },
  required: ["code"],
  additionalProperties: false,
};

export const COMPACTION_PROMPT = [
  "Summarize the older conversation context for a JS-first coding agent.",
  "Keep only durable facts, important intermediate results, and globals the next turn should remember.",
  "Write short bullet lines without markdown fences.",
].join("\n");

export const DEFAULT_ASSISTANT_REPLY =
  "I can use executeJS against a shared session scope, including fetch for external web access. Ask me to fetch data, store a value, or compute something.";
