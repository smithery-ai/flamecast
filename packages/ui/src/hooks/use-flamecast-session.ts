import { useCallback, useEffect, useRef, useState } from "react";
import type { WsChannelServerMessage } from "@flamecast/protocol/ws/channels";
import type { SessionLog, PermissionResponseBody } from "@flamecast/sdk/session";
import { useFlamecastClient } from "../provider.js";
import type { RuntimeWebSocketHandle } from "./use-runtime-websocket.js";

export type { ConnectionState } from "./use-runtime-websocket.js";

function toSessionLog(message: WsChannelServerMessage): SessionLog | null {
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

/**
 * Subscribes to a session channel on a shared runtime WebSocket.
 *
 * @param sessionId  The session to subscribe to.
 * @param ws         A shared {@link RuntimeWebSocketHandle} (from `useRuntimeWebSocket`).
 * @param ready      Whether the session is ready (i.e. has a websocketUrl from the REST API).
 */
export function useFlamecastSession(
  sessionId: string,
  ws: RuntimeWebSocketHandle,
  ready: boolean,
) {
  const client = useFlamecastClient();
  const [events, setEvents] = useState<SessionLog[]>([]);
  /** Track the last seq we've seen for replay-on-reconnect. */
  const lastSeqRef = useRef(0);

  // Destructure stable method refs so effects don't depend on the whole handle.
  const { subscribe, send: wsSend } = ws;

  useEffect(() => {
    setEvents([]);
    lastSeqRef.current = 0;

    if (!ready) return;

    const channel = `session:${sessionId}`;

    const unsubscribe = subscribe(
      channel,
      (message: WsChannelServerMessage) => {
        // Skip protocol-level messages that aren't session events.
        if (
          message.type === "subscribed" ||
          message.type === "unsubscribed" ||
          message.type === "pong"
        ) {
          return;
        }

        // Track sequence numbers for replay on reconnect.
        if (message.type === "event" && message.seq > lastSeqRef.current) {
          lastSeqRef.current = message.seq;
        }

        const log = toSessionLog(message);
        if (log) {
          setEvents((current) => [...current, log]);
        }
      },
      { getSince: () => lastSeqRef.current },
    );

    return unsubscribe;
  }, [sessionId, ready, subscribe]);

  const connectionState = ready ? ws.connectionState : "disconnected";

  const send = useCallback(
    (message: Parameters<RuntimeWebSocketHandle["send"]>[0]) => {
      wsSend(message);
    },
    [wsSend],
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
    send,
    prompt,
    respondToPermission,
    cancel,
    terminate,
    requestFilePreview,
    requestFsSnapshot,
  };
}
