import { useCallback, useSyncExternalStore } from "react";
import { useFlamecastContext } from "../lib/flamecast-context.js";
import type { ConnectionState } from "../lib/flamecast-connection.js";

/**
 * Access the shared FlamecastConnection and its state.
 *
 * @example
 * ```tsx
 * const { connection, connectionState, isConnected } = useFlamecast();
 * ```
 */
export function useFlamecast() {
  const { connection } = useFlamecastContext();

  const subscribe = useCallback(
    (onStoreChange: () => void) => connection.onStateChange(onStoreChange),
    [connection],
  );

  const getSnapshot = useCallback((): ConnectionState => connection.connectionState, [connection]);

  const connectionState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    connection,
    connectionState,
    isConnected: connectionState === "connected",
  };
}
