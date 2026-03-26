type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool_call"; code: string }
  | { role: "tool_result"; result: unknown; logs: string[]; error: { message: string } | null };

type SessionTranscript = {
  summary: string;
  transcript: TranscriptEntry[];
};

type CompactionEnv = {
  KEEP_RECENT_TURNS?: string;
  MAX_CONTEXT_TOKENS?: string;
  COMPACT_AT_CONTEXT_RATIO?: string;
  CF_AI_MODEL?: string;
};

const GPT_5_4_CONTEXT_WINDOW_TOKENS = 1_050_000;
const DEFAULT_COMPACTION_CONTEXT_RATIO = 0.8;

function jsonStringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function truncate(text: string, maxChars = 1200) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

export function serializeTranscript(session: SessionTranscript) {
  const parts: string[] = [];

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
          `[Tool result]\n${truncate(
            jsonStringify({
              result: entry.result,
              logs: entry.logs,
              error: entry.error,
            }),
          )}`,
        );
        break;
    }
  }

  return parts.join("\n\n");
}

export function estimateTokenCount(text: string) {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

export function getMaxContextTokens(
  env: Pick<CompactionEnv, "MAX_CONTEXT_TOKENS" | "CF_AI_MODEL">,
) {
  const override = Number(env.MAX_CONTEXT_TOKENS);
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  const model = env.CF_AI_MODEL?.toLowerCase() ?? "";
  if (model.includes("gpt-5.4")) {
    return GPT_5_4_CONTEXT_WINDOW_TOKENS;
  }

  return GPT_5_4_CONTEXT_WINDOW_TOKENS;
}

export function getCompactionThresholdTokens(
  env: Pick<CompactionEnv, "MAX_CONTEXT_TOKENS" | "CF_AI_MODEL" | "COMPACT_AT_CONTEXT_RATIO">,
) {
  const ratio = Number(env.COMPACT_AT_CONTEXT_RATIO);
  const thresholdRatio =
    Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_COMPACTION_CONTEXT_RATIO;

  return Math.floor(getMaxContextTokens(env) * thresholdRatio);
}

export function shouldCompactSession(env: CompactionEnv, session: SessionTranscript) {
  const keepRecentTurns = Number(env.KEEP_RECENT_TURNS ?? "6");
  if (session.transcript.length <= keepRecentTurns) {
    return false;
  }

  return estimateTokenCount(serializeTranscript(session)) > getCompactionThresholdTokens(env);
}
