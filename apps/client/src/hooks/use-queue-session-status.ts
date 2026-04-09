import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessions } from "@flamecast/ui";
import type { QueuedMessage } from "@/lib/message-queue-context";

export interface SessionStatus {
  processing: boolean;
  pendingPermission: boolean;
  connected: boolean;
}

/**
 * Tracks real-time processing status for sessions referenced in the message queue.
 *
 * Uses two layers:
 * 1. REST polling via useSessions() (every 5s) for baseline status
 * 2. WebSocket subscriptions per unique sessionId for real-time updates
 */
export function useQueueSessionStatus(queue: QueuedMessage[]) {
  const { data: sessions } = useSessions();

  // Stable set of unique sessionIds from the queue
  const sessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of queue) {
      if (m.sessionId) ids.add(m.sessionId);
    }
    return [...ids];
  }, [queue.map((m) => m.sessionId).join(",")]);

  // Stable map of sessionId -> websocketUrl
  const wsUrlMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!sessions) return map;
    for (const id of sessionIds) {
      const session = sessions.find((s) => s.id === id);
      if (session?.websocketUrl) {
        map.set(id, session.websocketUrl);
      }
    }
    return map;
  }, [sessionIds, sessions]);

  // REST-based status from useSessions() polling
  const restStatuses = useMemo(() => {
    const map = new Map<string, SessionStatus>();
    if (!sessions) return map;
    for (const id of sessionIds) {
      const session = sessions.find((s) => s.id === id);
      if (session) {
        map.set(id, {
          processing: session.promptQueue?.processing ?? false,
          pendingPermission: !!session.pendingPermission,
          connected: true,
        });
      }
    }
    return map;
  }, [sessionIds, sessions]);

  // WebSocket-based real-time statuses
  const [wsStatuses, setWsStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const protocolsRef = useRef<Map<string, "unknown" | "channel" | "direct-session">>(new Map());

  // Manage WebSocket connections incrementally — only open/close what changed
  useEffect(() => {
    // Open connections for new sessions
    for (const [id, url] of wsUrlMap) {
      if (wsRefs.current.has(id)) continue;

      const ws = new WebSocket(url);
      wsRefs.current.set(id, ws);
      protocolsRef.current.set(id, "unknown");

      const thisSessionId = id;

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));

          if (message.type === "connected") {
            if (typeof message.connectionId === "string") {
              protocolsRef.current.set(thisSessionId, "channel");
              ws.send(
                JSON.stringify({
                  action: "subscribe",
                  channel: `session:${thisSessionId}`,
                }),
              );
            } else if (typeof message.sessionId === "string") {
              protocolsRef.current.set(thisSessionId, "direct-session");
            }
            return;
          }

          if (message.type !== "event") {
            return;
          }

          const protocol = protocolsRef.current.get(thisSessionId) ?? "unknown";
          if (typeof message.channel === "string") {
            const expectedChannel = `session:${thisSessionId}`;
            if (
              message.channel !== expectedChannel &&
              !message.channel.startsWith(expectedChannel + ":")
            ) {
              return;
            }
          } else if (protocol !== "direct-session") {
            return;
          }

          if (message.type === "event" && message.event?.type === "queue.updated") {
            const data = message.event.data;
            setWsStatuses((prev) => {
              const next = new Map(prev);
              next.set(thisSessionId, {
                processing: data?.processing ?? false,
                pendingPermission: prev.get(thisSessionId)?.pendingPermission ?? false,
                connected: true,
              });
              return next;
            });
          }

          if (message.type === "event" && message.event?.type === "permission_request") {
            setWsStatuses((prev) => {
              const next = new Map(prev);
              next.set(thisSessionId, {
                processing: prev.get(thisSessionId)?.processing ?? false,
                pendingPermission: true,
                connected: true,
              });
              return next;
            });
          }

          if (
            message.type === "event" &&
            (message.event?.type === "permission_approved" ||
              message.event?.type === "permission_rejected" ||
              message.event?.type === "permission_cancelled" ||
              message.event?.type === "permission_responded")
          ) {
            setWsStatuses((prev) => {
              const next = new Map(prev);
              next.set(thisSessionId, {
                processing: prev.get(thisSessionId)?.processing ?? false,
                pendingPermission: false,
                connected: true,
              });
              return next;
            });
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        // Only clean up if this is still the active ws for this session
        if (wsRefs.current.get(thisSessionId) === ws) {
          wsRefs.current.delete(thisSessionId);
        }
        protocolsRef.current.delete(thisSessionId);
      };
    }

    // Close connections for sessions no longer tracked
    for (const [id, ws] of wsRefs.current) {
      if (!wsUrlMap.has(id)) {
        ws.close();
        wsRefs.current.delete(id);
        protocolsRef.current.delete(id);
        setWsStatuses((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [wsUrlMap]);

  // Full cleanup on unmount only
  useEffect(() => {
    return () => {
      for (const [, ws] of wsRefs.current) {
        ws.close();
      }
      wsRefs.current.clear();
      protocolsRef.current.clear();
    };
  }, []);

  // Merge REST and WS statuses (WS takes priority as it's more real-time)
  const getStatus = useCallback(
    (sessionId: string): SessionStatus | undefined => {
      return wsStatuses.get(sessionId) ?? restStatuses.get(sessionId);
    },
    [wsStatuses, restStatuses],
  );

  const isSessionBusy = useCallback(
    (sessionId: string): boolean => {
      const status = getStatus(sessionId);
      if (!status) return false;
      return status.processing || status.pendingPermission;
    },
    [getStatus],
  );

  return { getStatus, isSessionBusy };
}
