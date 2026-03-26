import { useRef, useEffect, useMemo, type ReactNode } from "react";
import { FlamecastConnection } from "../lib/flamecast-connection.js";
import { FlamecastContext } from "../lib/flamecast-context.js";

interface FlamecastProviderProps {
  /** WebSocket URL, e.g. "ws://localhost:3001/ws" */
  url: string;
  children: ReactNode;
}

/**
 * Provides a shared `FlamecastConnection` to all child hooks.
 * Connects on mount, disconnects on unmount.
 *
 * @example
 * ```tsx
 * <FlamecastProvider url="ws://localhost:3001/ws">
 *   <App />
 * </FlamecastProvider>
 * ```
 */
export function FlamecastProvider({ url, children }: FlamecastProviderProps) {
  const connectionRef = useRef<FlamecastConnection | null>(null);

  if (!connectionRef.current) {
    connectionRef.current = new FlamecastConnection({ url });
  }

  useEffect(() => {
    const conn = connectionRef.current;
    if (!conn) return;
    conn.connect();
    return () => conn.disconnect();
  }, [url]);

  const value = useMemo(() => {
    const connection = connectionRef.current;
    if (!connection) throw new Error("FlamecastConnection not initialized");
    return { connection };
  }, [url]);

  return <FlamecastContext.Provider value={value}>{children}</FlamecastContext.Provider>;
}
