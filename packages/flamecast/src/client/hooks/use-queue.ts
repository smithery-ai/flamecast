import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { PromptQueueState } from "@flamecast/protocol/session";
import { useFlamecastContext } from "../lib/flamecast-context.js";

const EMPTY_STATE: PromptQueueState = {
  processing: false,
  paused: false,
  items: [],
  size: 0,
};

/**
 * Subscribe to a session's prompt queue via the multiplexed connection.
 *
 * Supersedes the PR #77 version which used a direct FlamecastSession WS.
 * Same return API, different transport.
 *
 * @example
 * ```tsx
 * const { items, processing, paused, cancel, clear, reorder, pause, resume } = useQueue(sessionId);
 * ```
 */
export function useQueue(sessionId: string) {
  const { connection } = useFlamecastContext();
  const stateRef = useRef<PromptQueueState>(EMPTY_STATE);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const sub = connection.subscribe(`session:${sessionId}:queue`);

      const unsub = sub.onEvent((msg) => {
        const d = msg.event.data;

        if (msg.event.type === "queue.updated") {
          stateRef.current = {
            processing: Boolean(d.processing),
            paused: Boolean(d.paused),
            items: Array.isArray(d.items)
              ? d.items.map((item: Record<string, unknown>) => ({
                  queueId: String(item.queueId),
                  text: String(item.text),
                  enqueuedAt: String(item.enqueuedAt),
                  position: Number(item.position),
                }))
              : [],
            size: Number(d.size ?? 0),
          };
          onStoreChange();
        } else if (msg.event.type === "queue.paused") {
          stateRef.current = { ...stateRef.current, paused: true };
          onStoreChange();
        } else if (msg.event.type === "queue.resumed") {
          stateRef.current = { ...stateRef.current, paused: false };
          onStoreChange();
        }
      });

      return () => {
        unsub();
        sub.return();
      };
    },
    [connection, sessionId],
  );

  const getSnapshot = useCallback(() => stateRef.current, []);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    stateRef.current = EMPTY_STATE;
  }, [sessionId]);

  const cancel = useCallback(
    (queueId: string) => connection.cancel(sessionId, queueId),
    [connection, sessionId],
  );

  const clear = useCallback(() => connection.queueClear(sessionId), [connection, sessionId]);

  const reorder = useCallback(
    (order: string[]) => connection.queueReorder(sessionId, order),
    [connection, sessionId],
  );

  const pause = useCallback(() => connection.queuePause(sessionId), [connection, sessionId]);

  const resume = useCallback(() => connection.queueResume(sessionId), [connection, sessionId]);

  return {
    items: state.items,
    processing: state.processing,
    paused: state.paused,
    size: state.size,
    cancel,
    clear,
    reorder,
    pause,
    resume,
  };
}
