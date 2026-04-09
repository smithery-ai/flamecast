import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WsChannelControlMessage,
} from "@flamecast/protocol/ws/channels";
import {
  dismissRuntimeTerminal,
  loadDismissedRuntimeTerminals,
  reduceRuntimeTerminalSessions,
  type RuntimeTerminalSession,
} from "../lib/runtime-terminal-state.js";

export type TerminalSession = RuntimeTerminalSession;

type TerminalDataListener = (data: string) => void;

/**
 * Hook that manages terminal sessions scoped to this component instance.
 *
 * Instead of subscribing to the runtime-wide "terminals" channel (which would
 * leak terminals across sessions), the hook:
 *   1. Sends `terminal.create` and waits for a direct `terminal.created`
 *      response containing the assigned `terminalId`.
 *   2. Subscribes to `terminals:<terminalId>` for each terminal it owns.
 *
 * This ensures each session tab only sees the terminals it created.
 */
export function useTerminal(websocketUrl?: string) {
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<TerminalDataListener>>>(new Map());
  const queuedMessagesRef = useRef<WsChannelControlMessage[]>([]);
  const connectedRef = useRef(false);
  const ownedTerminalIdsRef = useRef<Set<string>>(new Set());
  const dismissedTerminalIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    setTerminals([]);
    listenersRef.current = new Map();
    queuedMessagesRef.current = [];
    connectedRef.current = false;
    ownedTerminalIdsRef.current = new Set();
    dismissedTerminalIdsRef.current = loadDismissedRuntimeTerminals(websocketUrl);

    if (!websocketUrl)
      return () => {
        disposed = true;
      };

    const ws = new WebSocket(websocketUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const message = JSON.parse(String(event.data));

        if (message.type === "connected") {
          connectedRef.current = true;
          // Flush queued control messages (terminal.create, input, resize, etc.)
          for (const pending of queuedMessagesRef.current) {
            ws.send(JSON.stringify(pending));
          }
          queuedMessagesRef.current = [];
          return;
        }

        // Direct response from the server after terminal.create — tells us the
        // assigned terminalId so we can subscribe to its channel.
        if (message.type === "terminal.created") {
          const terminalId = message.terminalId;
          if (typeof terminalId === "string") {
            ownedTerminalIdsRef.current.add(terminalId);
            // Subscribe to terminal-specific channel (replay from seq 0 to
            // catch the terminal.started event that may already be published).
            ws.send(
              JSON.stringify({
                action: "subscribe",
                channel: `terminals:${terminalId}`,
                since: 0,
              }),
            );
          }
          return;
        }

        // Channel subscription acknowledgments — no action needed.
        if (message.type === "subscribed" || message.type === "unsubscribed") {
          return;
        }

        if (message.type !== "event") return;

        const { type: eventType, data } = message.event;
        const terminalId = typeof data.terminalId === "string" ? data.terminalId : undefined;
        if (!terminalId) return;

        // Only process events for terminals this hook instance owns.
        if (!ownedTerminalIdsRef.current.has(terminalId)) return;

        if (eventType === "terminal.data") {
          const chunk = typeof data.data === "string" ? data.data : "";
          const listeners = listenersRef.current.get(terminalId);
          if (listeners && !dismissedTerminalIdsRef.current.has(terminalId)) {
            for (const fn of listeners) {
              fn(chunk);
            }
          }
        }

        setTerminals((prev) =>
          reduceRuntimeTerminalSessions(
            prev,
            {
              eventType,
              terminalId,
              timestamp: message.event.timestamp,
              command: typeof data.command === "string" ? data.command : undefined,
              data: typeof data.data === "string" ? data.data : undefined,
              exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
            },
            dismissedTerminalIdsRef.current,
          ),
        );
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      connectedRef.current = false;
      if (wsRef.current === ws) wsRef.current = null;
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      ws.close();
    };
  }, [websocketUrl]);

  const sendOrQueue = useCallback((message: WsChannelControlMessage) => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN || !connectedRef.current) {
      queuedMessagesRef.current.push(message);
      return;
    }
    ws.send(JSON.stringify(message));
  }, []);

  const sendInput = useCallback(
    (terminalId: string, data: string) => {
      const msg: WsChannelControlMessage = {
        action: "terminal.input",
        terminalId,
        data,
      };
      sendOrQueue(msg);
    },
    [sendOrQueue],
  );

  const resize = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      const msg: WsChannelControlMessage = {
        action: "terminal.resize",
        terminalId,
        cols,
        rows,
      };
      sendOrQueue(msg);
    },
    [sendOrQueue],
  );

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

  const createTerminal = useCallback(
    (command?: string) => {
      const msg: WsChannelControlMessage = {
        action: "terminal.create",
        data: command,
      };
      sendOrQueue(msg);
    },
    [sendOrQueue],
  );

  const killTerminal = useCallback(
    (terminalId: string) => {
      ownedTerminalIdsRef.current.delete(terminalId);
      dismissedTerminalIdsRef.current.add(terminalId);
      dismissRuntimeTerminal(websocketUrl, terminalId);
      const msg: WsChannelControlMessage = {
        action: "terminal.kill",
        terminalId,
      };
      sendOrQueue(msg);
      setTerminals((prev) => prev.filter((t) => t.terminalId !== terminalId));
    },
    [sendOrQueue, websocketUrl],
  );

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
