import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSession } from "../lib/api.js";
import { FlamecastSession, type ConnectionState } from "../lib/flamecast-session.js";
import type { SessionLog, PermissionResponseBody } from "../../shared/session.js";

/**
 * React hook that manages a FlamecastSession WebSocket connection.
 *
 * - Fetches session metadata via REST to get the websocketUrl
 * - Creates and manages a FlamecastSession lifecycle
 * - Provides event stream, control methods, and connection state
 */
export function useFlamecastSession(sessionId: string) {
  const sessionRef = useRef<FlamecastSession | null>(null);
  const eventsSnapshotRef = useRef<readonly SessionLog[]>([]);

  // Fetch session metadata to get websocketUrl
  const { data: sessionMeta } = useQuery({
    queryKey: ["session-meta", sessionId],
    queryFn: () => fetchSession(sessionId),
    staleTime: Infinity, // Only fetch once
  });

  const websocketUrl = sessionMeta?.websocketUrl;

  // Create/destroy FlamecastSession when websocketUrl changes
  useEffect(() => {
    if (!websocketUrl) return;

    const session = new FlamecastSession({
      websocketUrl,
      sessionId,
    });
    sessionRef.current = session;
    session.connect();

    return () => {
      session.disconnect();
      sessionRef.current = null;
    };
  }, [websocketUrl, sessionId]);

  // Subscribe to events for reactivity
  const subscribeToEvents = useCallback(
    (onStoreChange: () => void) => {
      const session = sessionRef.current;
      if (!session) return () => {};

      return session.on(() => {
        eventsSnapshotRef.current = [...session.events];
        onStoreChange();
      });
    },
    [websocketUrl, sessionId],
  );

  const getEventsSnapshot = useCallback(() => {
    return eventsSnapshotRef.current;
  }, []);

  const events = useSyncExternalStore(subscribeToEvents, getEventsSnapshot, getEventsSnapshot);

  // Subscribe to connection state for reactivity
  const subscribeToState = useCallback(
    (onStoreChange: () => void) => {
      const session = sessionRef.current;
      if (!session) return () => {};

      return session.onStateChange(() => {
        onStoreChange();
      });
    },
    [websocketUrl, sessionId],
  );

  const getConnectionState = useCallback((): ConnectionState => {
    return sessionRef.current?.connectionState ?? "disconnected";
  }, []);

  const connectionState = useSyncExternalStore(
    subscribeToState,
    getConnectionState,
    getConnectionState,
  );

  // Control methods
  const prompt = useCallback((text: string) => {
    sessionRef.current?.prompt(text);
  }, []);

  const respondToPermission = useCallback((requestId: string, body: PermissionResponseBody) => {
    sessionRef.current?.respondToPermission(requestId, body);
  }, []);

  const cancel = useCallback((queueId?: string) => {
    sessionRef.current?.cancel(queueId);
  }, []);

  const terminate = useCallback(() => {
    sessionRef.current?.terminate();
  }, []);

  const requestFilePreview = useCallback((path: string) => {
    return sessionRef.current?.requestFilePreview(path) ?? Promise.reject(new Error("No session"));
  }, []);

  return {
    events,
    connectionState,
    isConnected: connectionState === "connected",
    prompt,
    respondToPermission,
    cancel,
    terminate,
    requestFilePreview,
  };
}
