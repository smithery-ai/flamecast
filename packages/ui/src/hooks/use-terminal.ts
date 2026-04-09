import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WsChannelControlMessage,
  WsChannelServerMessage,
} from "@flamecast/protocol/ws/channels";
import {
  dismissRuntimeTerminal,
  loadDismissedRuntimeTerminals,
  reduceRuntimeTerminalSessions,
  type RuntimeTerminalSession,
} from "../lib/runtime-terminal-state.js";
import type { RuntimeWebSocketHandle } from "./use-runtime-websocket.js";

export type TerminalSession = RuntimeTerminalSession;

type TerminalDataListener = (data: string) => void;

/**
 * Hook that manages runtime-level terminal sessions.
 *
 * Terminals are independent of agent sessions — they live at the runtime
 * instance level. The hook subscribes to the "terminals" channel on the
 * shared runtime WebSocket.
 */
export function useTerminal(ws: RuntimeWebSocketHandle, websocketUrl?: string) {
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const listenersRef = useRef<Map<string, Set<TerminalDataListener>>>(new Map());
  const queuedMessagesRef = useRef<WsChannelControlMessage[]>([]);
  const subscribedRef = useRef(false);
  const dismissedTerminalIdsRef = useRef<Set<string>>(new Set());

  // Destructure stable method refs so effects don't depend on the whole handle.
  const { subscribe, send: wsSend } = ws;

  useEffect(() => {
    setTerminals([]);
    listenersRef.current = new Map();
    queuedMessagesRef.current = [];
    subscribedRef.current = false;
    dismissedTerminalIdsRef.current = loadDismissedRuntimeTerminals(websocketUrl);

    if (!websocketUrl) return;

    const unsubscribe = subscribe("terminals", (message: WsChannelServerMessage) => {
      if (message.type === "subscribed" && message.channel === "terminals") {
        subscribedRef.current = true;
        // Flush queued messages now that we're subscribed.
        for (const pending of queuedMessagesRef.current) {
          wsSend(pending);
        }
        queuedMessagesRef.current = [];
        return;
      }

      if (message.type !== "event") return;

      const { type: eventType, data } = message.event;
      const terminalId = typeof data.terminalId === "string" ? data.terminalId : undefined;
      if (!terminalId) return;

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
    });

    return () => {
      subscribedRef.current = false;
      unsubscribe();
    };
  }, [websocketUrl, subscribe, wsSend]);

  const sendOrQueue = useCallback(
    (message: WsChannelControlMessage) => {
      if (!subscribedRef.current) {
        queuedMessagesRef.current.push(message);
        return;
      }
      wsSend(message);
    },
    [wsSend],
  );

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
