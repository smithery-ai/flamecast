import { useCallback, useEffect, useState } from "react";
import type { SessionLog, PermissionResponseBody } from "@flamecast/sdk/session";
import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";
import { fetchSessionFilePreview, fetchSessionFileSystem } from "../lib/api.js";
import { useFlamecast } from "./use-flamecast.js";

function toSessionLog(message: WsChannelEventMessage): SessionLog {
  return {
    type: message.event.type,
    data: message.event.data,
    timestamp: message.event.timestamp,
  };
}

export function useFlamecastSession(sessionId: string) {
  const { connection, connectionState } = useFlamecast();
  const [events, setEvents] = useState<SessionLog[]>([]);

  useEffect(() => {
    setEvents([]);
    const subscription = connection.subscribe(`session:${sessionId}`);
    const unsubscribe = subscription.onEvent((message) => {
      setEvents((current) => [...current, toSessionLog(message)]);
    });

    return () => {
      unsubscribe();
      subscription.return();
    };
  }, [connection, sessionId]);

  const prompt = useCallback(
    (text: string) => {
      connection.prompt(sessionId, text);
    },
    [connection, sessionId],
  );

  const respondToPermission = useCallback(
    (requestId: string, body: PermissionResponseBody) => {
      connection.respondToPermission(sessionId, requestId, body);
    },
    [connection, sessionId],
  );

  const cancel = useCallback(
    (queueId?: string) => {
      connection.cancel(sessionId, queueId);
    },
    [connection, sessionId],
  );

  const terminate = useCallback(() => {
    connection.terminate(sessionId);
  }, [connection, sessionId]);

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
