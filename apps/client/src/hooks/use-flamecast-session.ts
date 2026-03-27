import { useCallback, useEffect, useRef, useState } from "react";
import type { WsChannelControlMessage, WsChannelServerMessage } from "@flamecast/protocol/ws/channels";
import type { WsServerMessage } from "@flamecast/protocol/ws";
import type { SessionLog, PermissionResponseBody } from "@flamecast/sdk/session";
import { fetchSessionFilePreview, fetchSessionFileSystem } from "../lib/api.js";
import { createWsMessageDedupeState, rememberWsMessage } from "../lib/ws-message-dedupe.js";

type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Detect whether the server speaks the new channel-based protocol (runtime-host)
 * or the old flat protocol (legacy session-host). The channel protocol sends
 * a {"type":"connected"} message on connect; the old protocol replays events
 * immediately.
 */
type WsProtocol = "unknown" | "channels" | "legacy";

function toSessionLog(message: WsChannelServerMessage | WsServerMessage): SessionLog | null {
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
  const seenMessagesRef = useRef(createWsMessageDedupeState());
  /** Track the last seq we've seen for replay-on-reconnect. */
  const lastSeqRef = useRef(0);
  /** Detected protocol — set on first message from the server. */
  const protocolRef = useRef<WsProtocol>("unknown");

  useEffect(() => {
    let disposed = false;
    setEvents([]);
    reconnectAttemptsRef.current = 0;
    seenMessagesRef.current = createWsMessageDedupeState();
    lastSeqRef.current = 0;
    protocolRef.current = "unknown";

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

    const openWebSocket = () => {
      if (disposed) return;
      setConnectionState(reconnectAttemptsRef.current === 0 ? "connecting" : "reconnecting");

      const ws = new WebSocket(websocketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");

        // Don't subscribe yet — wait to detect the protocol from the first
        // server message. The channel protocol sends {"type":"connected"}
        // immediately; the legacy protocol replays event history.
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;

        const rawMessage = String(event.data);
        if (!rememberWsMessage(seenMessagesRef.current, rawMessage)) {
          return;
        }

        try {
          const message = JSON.parse(rawMessage);

          // Detect protocol on first message
          if (protocolRef.current === "unknown") {
            if (message.type === "connected") {
              protocolRef.current = "channels";
              // Now subscribe to this session's channel
              const subscribeMsg: WsChannelControlMessage = {
                action: "subscribe",
                channel: `session:${sessionId}`,
                since: lastSeqRef.current,
              };
              ws.send(JSON.stringify(subscribeMsg));
              return; // Don't process the "connected" message as an event
            } else {
              protocolRef.current = "legacy";
              // Legacy protocol — events are already flowing
            }
          }

          // Track sequence numbers for channel protocol replay on reconnect
          if (message.type === "event" && typeof message.seq === "number" && message.seq > lastSeqRef.current) {
            lastSeqRef.current = message.seq;
          }

          // Skip non-event channel protocol messages (subscribed, pong, etc.)
          if (protocolRef.current === "channels" && message.type === "subscribed") {
            return;
          }

          const log = toSessionLog(message);
          if (log) {
            setEvents((current) => [...current, log]);
          }
        } catch {
          // Ignore malformed messages from the runtime host.
        }
      };

      ws.onclose = () => {
        const wasCurrent = wsRef.current === ws;
        if (wasCurrent) {
          wsRef.current = null;
        }

        if (disposed || !wasCurrent) {
          return;
        }

        reconnectAttemptsRef.current++;
        if (reconnectAttemptsRef.current > 5) {
          setConnectionState("disconnected");
          return;
        }

        // Reset protocol detection on reconnect
        protocolRef.current = "unknown";

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

  const send = useCallback(
    (message: WsChannelControlMessage) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // For legacy protocol, strip sessionId and send the old format
      if (protocolRef.current === "legacy") {
        const { sessionId: _sid, ...rest } = message as Record<string, unknown>;
        ws.send(JSON.stringify(rest));
        return;
      }

      ws.send(JSON.stringify(message));
    },
    [],
  );

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
      return fetchSessionFilePreview(sessionId, path);
    },
    [sessionId],
  );

  const requestFsSnapshot = useCallback(
    (opts?: { showAllFiles?: boolean }) => {
      return fetchSessionFileSystem(sessionId, opts);
    },
    [sessionId],
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
