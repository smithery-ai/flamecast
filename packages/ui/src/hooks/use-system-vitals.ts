import { useEffect, useRef, useState } from "react";
import type { WsChannelServerMessage } from "@flamecast/protocol/ws/channels";

/** System vitals snapshot pushed by the runtime host every few seconds. */
export interface SystemVitals {
  cpuPercent: number;
  memTotalMB: number;
  memUsedMB: number;
  memPercent: number;
  memAvailMB: number;
}

/**
 * Subscribe to system vitals from a runtime-host WebSocket.
 *
 * Connects to the given `websocketUrl`, subscribes to the `system:vitals`
 * channel, and returns the latest snapshot (or `null` before the first
 * reading arrives).
 */
export function useSystemVitals(websocketUrl?: string): SystemVitals | null {
  const [vitals, setVitals] = useState<SystemVitals | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    setVitals(null);

    if (!websocketUrl) return () => { disposed = true; };

    const ws = new WebSocket(websocketUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // If disposed before the socket opened, close immediately.
      if (disposed) {
        ws.close();
        return;
      }
    };

    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const message: WsChannelServerMessage = JSON.parse(String(event.data));

        if (message.type === "connected") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "subscribe", channel: "system:vitals" }));
          }
          return;
        }

        if (message.type !== "event") return;
        if (message.event.type !== "system.vitals") return;

        const d = message.event.data;
        setVitals({
          cpuPercent: d.cpuPercent as number,
          memTotalMB: d.memTotalMB as number,
          memUsedMB: d.memUsedMB as number,
          memPercent: d.memPercent as number,
          memAvailMB: d.memAvailMB as number,
        });
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      // Only close if the socket has finished connecting
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        ws.close();
      }
    };
  }, [websocketUrl]);

  return vitals;
}
