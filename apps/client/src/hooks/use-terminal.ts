import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useFlamecastContext } from "../lib/flamecast-context.js";
import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";

interface TerminalState {
  events: WsChannelEventMessage[];
}

const EMPTY: TerminalState = { events: [] };

/**
 * Subscribe to terminal output for a session.
 *
 * @example
 * ```tsx
 * const { events } = useTerminal(sessionId);
 * ```
 */
export function useTerminal(sessionId: string) {
  const { connection } = useFlamecastContext();
  const stateRef = useRef<TerminalState>(EMPTY);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const sub = connection.subscribe(`session:${sessionId}:terminal`);
      const unsub = sub.onEvent((event) => {
        stateRef.current = { events: [...stateRef.current.events, event] };
        onStoreChange();
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
    stateRef.current = EMPTY;
  }, [sessionId]);

  return { events: state.events };
}
