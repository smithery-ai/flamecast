import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useFlamecastContext } from "../lib/flamecast-context.js";
import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";

/**
 * Subscribe to filesystem changes for a session or agent.
 *
 * @example
 * ```tsx
 * // Session-level FS
 * const { events } = useFileSystem("session-123");
 *
 * // Agent-level FS (all sessions)
 * const { events } = useFileSystem({ agentId: "agent-123" });
 * ```
 */
export function useFileSystem(target: string | { agentId: string }) {
  const { connection } = useFlamecastContext();
  const eventsRef = useRef<WsChannelEventMessage[]>([]);

  const channel =
    typeof target === "string" ? `session:${target}:fs` : `agent:${target.agentId}:fs`;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const sub = connection.subscribe(channel);
      const unsub = sub.onEvent((event) => {
        eventsRef.current = [...eventsRef.current, event];
        onStoreChange();
      });
      return () => {
        unsub();
        sub.return();
      };
    },
    [connection, channel],
  );

  const getSnapshot = useCallback(() => eventsRef.current, []);
  const events = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    eventsRef.current = [];
  }, [channel]);

  return { events };
}
