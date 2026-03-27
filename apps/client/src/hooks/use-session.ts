import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useFlamecastContext } from "../lib/flamecast-context.js";
import type { ChannelSubscription } from "../lib/channel-subscription.js";
import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";
import type { PermissionResponseBody } from "@flamecast/sdk/session";

/**
 * Subscribe to a session's conversation events over the multiplexed connection.
 *
 * @example
 * ```tsx
 * const { events, prompt, respondToPermission, cancel, terminate } = useSession(sessionId);
 * ```
 */
export function useSession(sessionId: string) {
  const { connection } = useFlamecastContext();
  const subRef = useRef<ChannelSubscription | null>(null);
  const eventsRef = useRef<WsChannelEventMessage[]>([]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const channel = `session:${sessionId}`;
      const sub = connection.subscribe(channel);
      subRef.current = sub;

      const unsub = sub.onEvent((event) => {
        eventsRef.current = [...eventsRef.current, event];
        onStoreChange();
      });

      return () => {
        unsub();
        sub.return();
        subRef.current = null;
      };
    },
    [connection, sessionId],
  );

  const getSnapshot = useCallback(() => eventsRef.current, []);

  const events = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Reset events when sessionId changes
  useEffect(() => {
    eventsRef.current = [];
  }, [sessionId]);

  const prompt = useCallback(
    (text: string) => connection.prompt(sessionId, text),
    [connection, sessionId],
  );

  const respondToPermission = useCallback(
    (requestId: string, body: PermissionResponseBody) =>
      connection.respondToPermission(sessionId, requestId, body),
    [connection, sessionId],
  );

  const cancel = useCallback(
    (queueId?: string) => connection.cancel(sessionId, queueId),
    [connection, sessionId],
  );

  const terminate = useCallback(() => connection.terminate(sessionId), [connection, sessionId]);

  return { events, prompt, respondToPermission, cancel, terminate };
}
