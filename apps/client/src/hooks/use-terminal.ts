import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WsChannelControlMessage,
  WsChannelServerMessage,
} from "@flamecast/protocol/ws/channels";

export interface TerminalSession {
  terminalId: string;
  command: string;
  output: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

type TerminalDataListener = (data: string) => void;

/**
 * Hook that manages runtime-level terminal sessions.
 *
 * Terminals are independent of agent sessions — they live at the runtime
 * instance level. The hook subscribes to the "terminals" channel on the
 * runtime-host WebSocket.
 */
export function useTerminal(websocketUrl?: string) {
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<TerminalDataListener>>>(new Map());

  useEffect(() => {
    let disposed = false;
    setTerminals([]);
    listenersRef.current = new Map();

    if (!websocketUrl)
      return () => {
        disposed = true;
      };

    const ws = new WebSocket(websocketUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const message: WsChannelServerMessage = JSON.parse(String(event.data));

        if (message.type === "connected") {
          const subscribeMsg: WsChannelControlMessage = {
            action: "subscribe",
            channel: "terminals",
          };
          ws.send(JSON.stringify(subscribeMsg));
          return;
        }

        if (message.type !== "event") return;

        const { type: eventType, data } = message.event;
        const terminalId = typeof data.terminalId === "string" ? data.terminalId : undefined;
        if (!terminalId) return;

        switch (eventType) {
          case "terminal.started":
            setTerminals((prev) => [
              ...prev,
              {
                terminalId,
                command: typeof data.command === "string" ? data.command : "",
                output: "",
                exitCode: null,
                startedAt: message.event.timestamp,
                endedAt: null,
              },
            ]);
            break;

          case "terminal.data": {
            const chunk = typeof data.data === "string" ? data.data : "";
            setTerminals((prev) =>
              prev.map((t) =>
                t.terminalId === terminalId ? { ...t, output: t.output + chunk } : t,
              ),
            );
            const listeners = listenersRef.current.get(terminalId);
            if (listeners) {
              for (const fn of listeners) {
                fn(chunk);
              }
            }
            break;
          }

          case "terminal.exit":
            setTerminals((prev) =>
              prev.map((t) =>
                t.terminalId === terminalId
                  ? {
                      ...t,
                      exitCode: typeof data.exitCode === "number" ? data.exitCode : -1,
                      endedAt: message.event.timestamp,
                    }
                  : t,
              ),
            );
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      ws.close();
    };
  }, [websocketUrl]);

  const sendInput = useCallback((terminalId: string, data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: WsChannelControlMessage = {
      action: "terminal.input",
      terminalId,
      data,
    };
    ws.send(JSON.stringify(msg));
  }, []);

  const resize = useCallback((terminalId: string, cols: number, rows: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: WsChannelControlMessage = {
      action: "terminal.resize",
      terminalId,
      cols,
      rows,
    };
    ws.send(JSON.stringify(msg));
  }, []);

  const onData = useCallback((terminalId: string, listener: TerminalDataListener): (() => void) => {
    let set = listenersRef.current.get(terminalId);
    if (!set) {
      set = new Set();
      listenersRef.current.set(terminalId, set);
    }
    set.add(listener);
    return () => {
      listenersRef.current.get(terminalId)?.delete(listener);
    };
  }, []);

  const createTerminal = useCallback((command?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: WsChannelControlMessage = {
      action: "terminal.create",
      data: command,
    };
    ws.send(JSON.stringify(msg));
  }, []);

  const killTerminal = useCallback((terminalId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: WsChannelControlMessage = {
      action: "terminal.kill",
      terminalId,
    };
    ws.send(JSON.stringify(msg));
    setTerminals((prev) => prev.filter((t) => t.terminalId !== terminalId));
  }, []);

  const activeTerminal = useMemo(() => {
    const running = terminals.filter((t) => t.exitCode === null);
    return running.length > 0
      ? running[running.length - 1]
      : (terminals[terminals.length - 1] ?? null);
  }, [terminals]);

  return {
    terminals,
    activeTerminal,
    sendInput,
    resize,
    onData,
    createTerminal,
    killTerminal,
  };
}
