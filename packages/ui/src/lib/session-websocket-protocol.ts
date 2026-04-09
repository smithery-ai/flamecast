import type { SessionLog, PermissionResponseBody } from "@flamecast/sdk/session";

export type SessionWebSocketProtocol =
  | { kind: "unknown" }
  | { kind: "channel" }
  | { kind: "direct-session"; sessionId: string };

export type SessionControlMessage =
  | { action: "prompt"; sessionId: string; text: string }
  | {
      action: "permission.respond";
      sessionId: string;
      requestId: string;
      body: PermissionResponseBody;
    }
  | { action: "cancel"; sessionId: string; queueId?: string }
  | { action: "terminate"; sessionId: string }
  | { action: "queue.reorder"; sessionId: string; order: string[] }
  | { action: "queue.clear"; sessionId: string }
  | { action: "queue.pause"; sessionId: string }
  | { action: "queue.resume"; sessionId: string }
  | { action: "ping" };

export type NormalizedSessionLogMessage = {
  log: SessionLog;
  seq?: number;
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

export function toNormalizedSessionLogMessage(
  message: unknown,
  sessionId: string,
  protocol: SessionWebSocketProtocol,
): NormalizedSessionLogMessage | null {
  if (!isRecord(message) || typeof message.type !== "string") {
    return null;
  }

  if (message.type === "error") {
    if (
      protocol.kind === "channel" &&
      typeof message.channel === "string" &&
      !isLocalSessionChannel(sessionId, message.channel)
    ) {
      return null;
    }

    return {
      log: {
        type: "error",
        data: { message: typeof message.message === "string" ? message.message : "Unknown error" },
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (
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

    return {
      log: {
        type: message.event.type,
        data: message.event.data,
        timestamp: message.event.timestamp,
      },
      seq: typeof message.seq === "number" ? message.seq : undefined,
    };
  }

  if (protocol.kind === "direct-session") {
    return {
      log: {
        type: message.event.type,
        data: message.event.data,
        timestamp: message.event.timestamp,
      },
    };
  }

  return null;
}

export function toWireSessionControlMessage(
  message: SessionControlMessage,
  protocol: SessionWebSocketProtocol,
): Record<string, unknown> | null {
  if (protocol.kind !== "direct-session") {
    return message;
  }

  if ("sessionId" in message && message.sessionId !== protocol.sessionId) {
    return null;
  }

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
  }
}
