import type { WsChannelControlMessage } from "@flamecast/protocol/ws/channels";

export type RuntimeWebSocketProtocol =
  | { kind: "unknown" }
  | { kind: "channel" }
  | { kind: "direct-session"; sessionId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function detectRuntimeWebSocketProtocol(message: unknown): RuntimeWebSocketProtocol | null {
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

export function getRuntimeWebSocketChannel(
  message: unknown,
  protocol: RuntimeWebSocketProtocol,
): string | undefined {
  if (!isRecord(message) || typeof message.type !== "string") {
    return undefined;
  }

  if (typeof message.channel === "string") {
    return message.channel;
  }

  if (
    protocol.kind === "direct-session" &&
    (message.type === "event" || message.type === "error")
  ) {
    return `session:${protocol.sessionId}`;
  }

  return undefined;
}

export function toWireControlMessage(
  message: WsChannelControlMessage,
  protocol: RuntimeWebSocketProtocol,
): Record<string, unknown> | null {
  if (protocol.kind !== "direct-session") {
    return message;
  }

  switch (message.action) {
    case "subscribe":
    case "unsubscribe":
      return null;
    case "prompt":
      if (message.sessionId !== protocol.sessionId) return null;
      return { action: "prompt", text: message.text };
    case "permission.respond":
      if (message.sessionId !== protocol.sessionId) return null;
      return {
        action: "permission.respond",
        requestId: message.requestId,
        body: message.body,
      };
    case "cancel":
      if (message.sessionId !== protocol.sessionId) return null;
      return message.queueId
        ? { action: "cancel", queueId: message.queueId }
        : { action: "cancel" };
    case "terminate":
      if (message.sessionId !== protocol.sessionId) return null;
      return { action: "terminate" };
    case "queue.reorder":
      if (message.sessionId !== protocol.sessionId) return null;
      return { action: "queue.reorder", order: message.order };
    case "queue.clear":
      if (message.sessionId !== protocol.sessionId) return null;
      return { action: "queue.clear" };
    case "queue.pause":
      if (message.sessionId !== protocol.sessionId) return null;
      return { action: "queue.pause" };
    case "queue.resume":
      if (message.sessionId !== protocol.sessionId) return null;
      return { action: "queue.resume" };
    case "ping":
      return { action: "ping" };
    case "terminal.create":
    case "terminal.input":
    case "terminal.resize":
    case "terminal.kill":
      return null;
  }
}
