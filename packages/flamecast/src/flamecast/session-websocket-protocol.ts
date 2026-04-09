import type { PermissionResponseBody } from "../shared/session.js";
import { resolveAgentId } from "./events/channels.js";

export type SessionWebSocketProtocol =
  | { kind: "unknown" }
  | { kind: "channel" }
  | { kind: "direct-session"; sessionId: string };

export type NormalizedSessionTapEvent = {
  sessionId: string;
  agentId: string;
  event: {
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLocalSessionChannel(expectedSessionId: string, channel: string): boolean {
  const sessionChannel = `session:${expectedSessionId}`;
  return channel === sessionChannel || channel.startsWith(sessionChannel + ":");
}

export function detectSessionWebSocketProtocol(message: unknown): SessionWebSocketProtocol | null {
  if (!isRecord(message) || message.type !== "connected") {
    return null;
  }

  if (typeof message.connectionId === "string") {
    return { kind: "channel" };
  }

  if (typeof message.sessionId === "string") {
    return { kind: "direct-session", sessionId: message.sessionId };
  }

  return null;
}

export function toNormalizedSessionTapEvent(
  message: unknown,
  sessionId: string,
  protocol: SessionWebSocketProtocol,
): NormalizedSessionTapEvent | null {
  if (
    !isRecord(message) ||
    message.type !== "event" ||
    !isRecord(message.event) ||
    typeof message.event.type !== "string" ||
    !isRecord(message.event.data) ||
    typeof message.event.timestamp !== "string"
  ) {
    return null;
  }

  if (protocol.kind === "channel") {
    if (typeof message.channel !== "string" || !isLocalSessionChannel(sessionId, message.channel)) {
      return null;
    }

    const normalizedSessionId =
      typeof message.sessionId === "string" ? message.sessionId : sessionId;
    return {
      sessionId: normalizedSessionId,
      agentId:
        typeof message.agentId === "string" ? message.agentId : resolveAgentId(normalizedSessionId),
      event: {
        type: message.event.type,
        data: message.event.data,
        timestamp: message.event.timestamp,
      },
    };
  }

  if (protocol.kind === "direct-session") {
    return {
      sessionId,
      agentId: resolveAgentId(sessionId),
      event: {
        type: message.event.type,
        data: message.event.data,
        timestamp: message.event.timestamp,
      },
    };
  }

  return null;
}

export function toSessionPermissionResponseMessage(
  protocol: SessionWebSocketProtocol,
  sessionId: string,
  requestId: string,
  body: PermissionResponseBody,
): Record<string, unknown> {
  if (protocol.kind === "direct-session") {
    return {
      action: "permission.respond",
      requestId,
      body,
    };
  }

  return {
    action: "permission.respond",
    sessionId,
    requestId,
    body,
  };
}
