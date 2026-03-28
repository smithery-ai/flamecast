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
 * Hook that tracks terminal sessions for a given Flamecast session.
 *
 * Feed it the same `websocketUrl` and `sessionId` used by `useFlamecastSession`.
 * It subscribes to the terminal-specific channel and maintains per-terminal
 * output buffers.
 */
export function useTerminal(sessionId: string, websocketUrl?: string) {
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<TerminalDataListener>>>(new Map());

  useEffect(() => {
    let disposed = false;
    setTerminals([]);
    listenersRef.current = new Map();

    if (!websocketUrl) return () => { disposed = true; };

    const ws = new WebSocket(websocketUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Wait for "connected" message before subscribing
    };

    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const message: WsChannelServerMessage = JSON.parse(String(event.data));

        if (message.type === "connected") {
          const subscribeMsg: WsChannelControlMessage = {
            action: "subscribe",
            channel: `session:${sessionId}:terminal`,
          };
          ws.send(JSON.stringify(subscribeMsg));
          return;
        }

        if (message.type !== "event") return;

        const { type: eventType, data } = message.event;
        const terminalId = (data as Record<string, unknown>).terminalId as string | undefined;
        if (!terminalId) return;

        switch (eventType) {
          case "terminal.started":
            setTerminals((prev) => [
              ...prev,
              {
                terminalId,
                command: (data as Record<string, unknown>).command as string ?? "",
                output: "",
                exitCode: null,
                startedAt: message.event.timestamp,
                endedAt: null,
              },
            ]);
            break;

          case "terminal.data": {
            const chunk = (data as Record<string, unknown>).data as string ?? "";
            setTerminals((prev) =>
              prev.map((t) =>
                t.terminalId === terminalId
                  ? { ...t, output: t.output + chunk }
                  : t,
              ),
            );
            // Notify listeners
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
                      exitCode: (data as Record<string, unknown>).exitCode as number ?? -1,
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
  }, [sessionId, websocketUrl]);

  const sendInput = useCallback(
    (terminalId: string, data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: WsChannelControlMessage = {
        action: "terminal.input",
        sessionId,
        terminalId,
        data,
      };
      ws.send(JSON.stringify(msg));
    },
    [sessionId],
  );

  const resize = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: WsChannelControlMessage = {
        action: "terminal.resize",
        sessionId,
        terminalId,
        cols,
        rows,
      };
      ws.send(JSON.stringify(msg));
    },
    [sessionId],
  );

  const onData = useCallback(
    (terminalId: string, listener: TerminalDataListener): (() => void) => {
      if (!listenersRef.current.has(terminalId)) {
        listenersRef.current.set(terminalId, new Set());
      }
      listenersRef.current.get(terminalId)!.add(listener);
      return () => {
        listenersRef.current.get(terminalId)?.delete(listener);
      };
    },
    [],
  );

  const createTerminal = useCallback(
    (command?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: WsChannelControlMessage = {
        action: "terminal.create",
        sessionId,
        data: command,
      };
      ws.send(JSON.stringify(msg));
    },
    [sessionId],
  );

  const killTerminal = useCallback(
    (terminalId: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: WsChannelControlMessage = {
        action: "terminal.kill",
        sessionId,
        terminalId,
      };
      ws.send(JSON.stringify(msg));
      setTerminals((prev) => prev.filter((t) => t.terminalId !== terminalId));
    },
    [sessionId],
  );

  const activeTerminal = useMemo(() => {
    const running = terminals.filter((t) => t.exitCode === null);
    return running.length > 0 ? running[running.length - 1] : terminals[terminals.length - 1] ?? null;
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
