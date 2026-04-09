import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLog, PermissionResponseBody } from "@flamecast/sdk/session";
import { useFlamecastClient } from "../provider.js";
import { createWsMessageDedupeState, rememberWsMessage } from "../lib/ws-message-dedupe.js";
import {
  detectSessionWebSocketProtocol,
  toNormalizedSessionLogMessage,
  toWireSessionControlMessage,
  type SessionControlMessage,
  type SessionWebSocketProtocol,
} from "../lib/session-websocket-protocol.js";
import type { ConnectionState } from "./use-runtime-websocket.js";

export type { ConnectionState } from "./use-runtime-websocket.js";

export function useFlamecastSession(sessionId: string, websocketUrl?: string) {
  const client = useFlamecastClient();
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    websocketUrl ? "connecting" : "disconnected",
  );

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastSeqRef = useRef(0);
  const seenMessagesRef = useRef(createWsMessageDedupeState());
  const protocolRef = useRef<SessionWebSocketProtocol>({ kind: "unknown" });

  useEffect(() => {
    let disposed = false;
    reconnectAttemptsRef.current = 0;
    lastSeqRef.current = 0;
    seenMessagesRef.current = createWsMessageDedupeState();
    protocolRef.current = { kind: "unknown" };
    setEvents([]);

    if (!websocketUrl) {
      setConnectionState("disconnected");
      return () => {
        disposed = true;
      };
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const subscribeToSession = (ws: WebSocket) => {
      const since = lastSeqRef.current;
      const message = {
        action: "subscribe",
        channel: `session:${sessionId}`,
        ...(since ? { since } : {}),
      };
      ws.send(JSON.stringify(message));
    };

    const openWebSocket = () => {
      if (disposed) return;
      setConnectionState(reconnectAttemptsRef.current === 0 ? "connecting" : "reconnecting");

      const ws = new WebSocket(websocketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;

        const rawMessage = String(event.data);

        try {
          const message: unknown = JSON.parse(rawMessage);

          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "event"
          ) {
            if (!rememberWsMessage(seenMessagesRef.current, rawMessage)) {
              return;
            }
          }

          const protocol = detectSessionWebSocketProtocol(message);
          if (protocol) {
            protocolRef.current = protocol;
            if (protocol.kind === "channel") {
              subscribeToSession(ws);
            }
            return;
          }

          const normalized = toNormalizedSessionLogMessage(message, sessionId, protocolRef.current);
          if (!normalized) return;

          if (normalized.seq && normalized.seq > lastSeqRef.current) {
            lastSeqRef.current = normalized.seq;
          }

          setEvents((current) => [...current, normalized.log]);
        } catch {
          // Ignore malformed messages from the runtime host.
        }
      };

      ws.onclose = () => {
        const wasCurrent = wsRef.current === ws;
        if (wasCurrent) {
          wsRef.current = null;
        }

        if (disposed || !wasCurrent) return;

        reconnectAttemptsRef.current++;
        if (reconnectAttemptsRef.current > 5) {
          setConnectionState("disconnected");
          return;
        }

        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 16_000);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          openWebSocket();
        }, delay);
      };
    };

    openWebSocket();

    return () => {
      disposed = true;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.close();
      }
    };
  }, [sessionId, websocketUrl]);

  const send = useCallback((message: SessionControlMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = toWireSessionControlMessage(message, protocolRef.current);
    if (!payload) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const prompt = useCallback(
    (text: string) => {
      send({ action: "prompt", sessionId, text });
    },
    [send, sessionId],
  );

  const respondToPermission = useCallback(
    (requestId: string, body: PermissionResponseBody) => {
      send({ action: "permission.respond", sessionId, requestId, body });
    },
    [send, sessionId],
  );

  const cancel = useCallback(
    (queueId?: string) => {
      send({ action: "cancel", sessionId, queueId });
    },
    [send, sessionId],
  );

  const terminate = useCallback(() => {
    send({ action: "terminate", sessionId });
  }, [send, sessionId]);

  const requestFilePreview = useCallback(
    (path: string) => {
      return client.fetchSessionFilePreview(sessionId, path);
    },
    [client, sessionId],
  );

  const requestFsSnapshot = useCallback(
    (opts?: { showAllFiles?: boolean }) => {
      return client.fetchSessionFileSystem(sessionId, opts);
    },
    [client, sessionId],
  );

  return {
    events,
    connectionState,
    isConnected: connectionState === "connected",
    prompt,
    respondToPermission,
    cancel,
    terminate,
    requestFilePreview,
    requestFsSnapshot,
  };
}
