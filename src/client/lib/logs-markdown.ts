import * as acp from "@agentclientprotocol/sdk";
import type { SessionLog } from "@/shared/session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ConnectionLogMarkdownSegment =
  | { kind: "assistant"; text: string }
  | { kind: "user"; text: string }
  | { kind: "tool"; toolCallId: string; title: string; status: string };

function appendAssistant(segments: ConnectionLogMarkdownSegment[], chunk: string): void {
  const last = segments.at(-1);
  if (last?.kind === "assistant") {
    last.text += chunk;
  } else {
    segments.push({ kind: "assistant", text: chunk });
  }
}

function appendUser(segments: ConnectionLogMarkdownSegment[], chunk: string): void {
  const last = segments.at(-1);
  if (last?.kind === "user") {
    last.text += chunk;
  } else {
    segments.push({ kind: "user", text: chunk });
  }
}

/** Session notification body (legacy flat logs or `payload.update` from RPC). */
function applySessionUpdateRecord(
  d: Record<string, unknown>,
  segments: ConnectionLogMarkdownSegment[],
): void {
  const su = d.sessionUpdate;
  if (typeof su !== "string") return;

  if (su === "agent_message_chunk") {
    const content = d.content;
    if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
      appendAssistant(segments, content.text);
    }
  } else if (su === "user_message_chunk") {
    const content = d.content;
    if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
      appendUser(segments, content.text);
    }
  } else if (su === "tool_call") {
    const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
    const title = typeof d.title === "string" ? d.title : "Tool";
    const status = typeof d.status === "string" ? d.status : "";
    segments.push({ kind: "tool", toolCallId, title, status });
  } else if (su === "tool_call_update") {
    const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
    const status = typeof d.status === "string" ? d.status : "";
    applyToolSegmentStatus(segments, toolCallId, status);
  }
}

function applyToolSegmentStatus(
  segments: ConnectionLogMarkdownSegment[],
  toolCallId: string,
  status: string,
): void {
  if (!toolCallId || !status) return;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind === "tool" && seg.toolCallId === toolCallId) {
      seg.status = status;
      break;
    }
  }
}

/** Ordered segments for the markdown tab (prompts + session stream updates). */
export function connectionLogsToSegments(logs: SessionLog[]): ConnectionLogMarkdownSegment[] {
  const segments: ConnectionLogMarkdownSegment[] = [];

  for (const log of logs) {
    if (log.type === "prompt_sent") {
      const d = log.data;
      if (isRecord(d) && typeof d.text === "string" && d.text.length > 0) {
        appendUser(segments, d.text);
      }
      continue;
    }

    if (log.type === "session_update") {
      const d = log.data;
      if (isRecord(d)) {
        applySessionUpdateRecord(d, segments);
      }
      continue;
    }

    if (log.type === "permission_cancelled") {
      const d = log.data;
      if (isRecord(d) && typeof d.toolCallId === "string") {
        applyToolSegmentStatus(segments, d.toolCallId, "cancelled");
      }
      continue;
    }

    if (log.type === "permission_rejected") {
      const d = log.data;
      if (isRecord(d) && typeof d.toolCallId === "string") {
        applyToolSegmentStatus(segments, d.toolCallId, "rejected");
      }
      continue;
    }

    if (log.type === "rpc") {
      const d = log.data;
      if (!isRecord(d)) continue;

      const method = d.method;
      const direction = d.direction;
      const phase = d.phase;

      if (
        method === acp.AGENT_METHODS.session_prompt &&
        direction === "client_to_agent" &&
        phase === "request"
      ) {
        const payload = d.payload;
        if (isRecord(payload) && Array.isArray(payload.prompt)) {
          for (const item of payload.prompt) {
            if (
              isRecord(item) &&
              item.type === "text" &&
              typeof item.text === "string" &&
              item.text.length > 0
            ) {
              appendUser(segments, item.text);
            }
          }
        }
        continue;
      }

      if (
        method === acp.CLIENT_METHODS.session_update &&
        direction === "agent_to_client" &&
        phase === "notification"
      ) {
        const payload = d.payload;
        if (isRecord(payload) && isRecord(payload.update)) {
          applySessionUpdateRecord(payload.update, segments);
        }
      }
    }
  }

  return segments;
}
