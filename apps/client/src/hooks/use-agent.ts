import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useFlamecastContext } from "../lib/flamecast-context.js";
import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";
import type { PermissionResponseBody } from "@flamecast/sdk/session";

/**
 * Subscribe to all events for an agent (all sessions).
 *
 * @example
 * ```tsx
 * const { events, prompt, respondToPermission, terminate } = useAgent(agentId);
 * ```
 */
export function useAgent(agentId: string) {
  const { connection } = useFlamecastContext();
  const eventsRef = useRef<WsChannelEventMessage[]>([]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const sub = connection.subscribe(`agent:${agentId}`);
      const unsub = sub.onEvent((event) => {
        eventsRef.current = [...eventsRef.current, event];
        onStoreChange();
      });
      return () => {
        unsub();
        sub.return();
      };
    },
    [connection, agentId],
  );

  const getSnapshot = useCallback(() => eventsRef.current, []);
  const events = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    eventsRef.current = [];
  }, [agentId]);

  const prompt = useCallback(
    (sessionId: string, text: string) => connection.prompt(sessionId, text),
    [connection],
  );

  const respondToPermission = useCallback(
    (sessionId: string, requestId: string, body: PermissionResponseBody) =>
      connection.respondToPermission(sessionId, requestId, body),
    [connection],
  );

  const terminate = useCallback(
    (sessionId: string) => connection.terminate(sessionId),
    [connection],
  );

  return { events, prompt, respondToPermission, terminate };
}
