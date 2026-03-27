import { useCallback, useEffect, useRef, useState } from "react";
import type { WsControlMessage, WsServerMessage } from "@flamecast/protocol/ws";
import type { SessionLog, PermissionResponseBody } from "@flamecast/sdk/session";
import { fetchSessionFilePreview, fetchSessionFileSystem } from "../lib/api.js";

type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

function toSessionLog(message: WsServerMessage): SessionLog | null {
  if (message.type === "error") {
    return {
      type: "error",
      data: { message: message.message },
      timestamp: new Date().toISOString(),
    };
  }

  if (message.type !== "event") return null;

  return {
    type: message.event.type,
    data: message.event.data,
    timestamp: message.event.timestamp,
  };
}

export function useFlamecastSession(sessionId: string, websocketUrl?: string) {
  const [events, setEvents] = useState<SessionLog[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    websocketUrl ? "connecting" : "disconnected",
  );
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    setEvents([]);
    reconnectAttemptsRef.current = 0;

    if (!websocketUrl) {
      setConnectionState("disconnected");
      return () => {
        closedRef.current = true;
      };
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const openWebSocket = () => {
      setConnectionState(reconnectAttemptsRef.current === 0 ? "connecting" : "reconnecting");

      const ws = new WebSocket(websocketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");
      };

      ws.onmessage = (event) => {
        try {
          const message: WsServerMessage = JSON.parse(String(event.data));
          const log = toSessionLog(message);
          if (log) {
            setEvents((current) => [...current, log]);
          }
        } catch {
          // Ignore malformed messages from the runtime host.
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (closedRef.current) {
          setConnectionState("disconnected");
          return;
        }

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
      closedRef.current = true;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.close();
      }
    };
  }, [sessionId, websocketUrl]);

  const send = useCallback((message: WsControlMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }, []);

  const prompt = useCallback(
    (text: string) => {
      send({ action: "prompt", text });
    },
    [send],
  );

  const respondToPermission = useCallback(
    (requestId: string, body: PermissionResponseBody) => {
      send({ action: "permission.respond", requestId, body });
    },
    [send],
  );

  const cancel = useCallback(
    (queueId?: string) => {
      send({ action: "cancel", queueId });
    },
    [send],
  );

  const terminate = useCallback(() => {
    send({ action: "terminate" });
  }, [send]);

  const requestFilePreview = useCallback(
    (path: string) => {
      return fetchSessionFilePreview(sessionId, path);
    },
    [sessionId],
  );

  const requestFsSnapshot = useCallback(() => {
    return fetchSessionFileSystem(sessionId);
  }, [sessionId]);

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
