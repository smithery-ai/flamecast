import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { PromptQueueState } from "@flamecast/protocol/session";
import type { FlamecastSession } from "../lib/flamecast-session.js";

const EMPTY_STATE: PromptQueueState = {
  processing: false,
  paused: false,
  items: [],
  size: 0,
};

/**
 * React hook for managing a session's prompt queue.
 *
 * Subscribes to `queue.updated`, `queue.paused`, and `queue.resumed` WS events
 * from the FlamecastSession and provides control methods for queue management.
 *
 * @param session - A FlamecastSession instance (from useFlamecastSession's ref)
 */
export function useQueue(session: FlamecastSession | null) {
  const stateRef = useRef<PromptQueueState>(EMPTY_STATE);

  // Subscribe to queue events from the session's WS stream
  useEffect(() => {
    if (!session) return;

    const unsub = session.on((event) => {
      if (event.type === "queue.updated") {
        // Queue state is broadcast as the event data payload
        const d = event.data;
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
      } else if (event.type === "queue.paused") {
        stateRef.current = { ...stateRef.current, paused: true };
      } else if (event.type === "queue.resumed") {
        stateRef.current = { ...stateRef.current, paused: false };
      }
    });

    return unsub;
  }, [session]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!session) return () => {};
      return session.on((event) => {
        if (
          event.type === "queue.updated" ||
          event.type === "queue.paused" ||
          event.type === "queue.resumed"
        ) {
          onStoreChange();
        }
      });
    },
    [session],
  );

  const getSnapshot = useCallback(() => stateRef.current, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const cancel = useCallback(
    (queueId: string) => {
      session?.cancel(queueId);
    },
    [session],
  );

  const clear = useCallback(() => {
    session?.clearQueue();
  }, [session]);

  const reorder = useCallback(
    (order: string[]) => {
      session?.reorderQueue(order);
    },
    [session],
  );

  const pause = useCallback(() => {
    session?.pauseQueue();
  }, [session]);

  const resume = useCallback(() => {
    session?.resumeQueue();
  }, [session]);

  return {
    items: state.items,
    processing: state.processing,
    paused: state.paused,
    cancel,
    clear,
    reorder,
    pause,
    resume,
  };
}
