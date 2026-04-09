import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WsChannelControlMessage,
  WsChannelServerMessage,
} from "@flamecast/protocol/ws/channels";
import { createWsMessageDedupeState, rememberWsMessage } from "../lib/ws-message-dedupe.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type ChannelMessageHandler = (message: WsChannelServerMessage) => void;

export interface RuntimeWebSocketHandle {
  /** Current connection state of the underlying WebSocket. */
  connectionState: ConnectionState;

  /**
   * Subscribe to a channel. The handler receives every server message tagged
   * with this channel (including `subscribed`, `event`, `error`).
   *
   * `opts.getSince` is called on every (re-)subscribe to obtain the latest
   * sequence number for replay.
   *
   * Returns an unsubscribe function.
   */
  subscribe(
    channel: string,
    handler: ChannelMessageHandler,
    opts?: { getSince?: () => number },
  ): () => void;

  /** Send a control message on the WebSocket (prompt, terminal input, etc.). */
  send(message: WsChannelControlMessage): void;
}

/**
 * Manages a single multiplexed WebSocket connection to a runtime-host instance.
 *
 * Multiple consumers (session events, terminal events, etc.) share this
 * connection by subscribing to different channels.
 */
export function useRuntimeWebSocket(websocketUrl?: string): RuntimeWebSocketHandle {
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    websocketUrl ? "connecting" : "disconnected",
  );

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const seenMessagesRef = useRef(createWsMessageDedupeState());

  /** channel → { handlers, getSince } */
  const channelSubsRef = useRef<
    Map<string, { handlers: Set<ChannelMessageHandler>; getSince?: () => number }>
  >(new Map());

  useEffect(() => {
    let disposed = false;
    reconnectAttemptsRef.current = 0;
    seenMessagesRef.current = createWsMessageDedupeState();

    if (!websocketUrl) {
      setConnectionState("disconnected");
      return () => {
        disposed = true;
      };
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const subscribeAll = (ws: WebSocket) => {
      for (const [channel, sub] of channelSubsRef.current) {
        const since = sub.getSince?.();
        const msg: WsChannelControlMessage = {
          action: "subscribe",
          channel,
          ...(since ? { since } : {}),
        };
        ws.send(JSON.stringify(msg));
      }
    };

    const openWebSocket = () => {
      if (disposed) return;
      setConnectionState(reconnectAttemptsRef.current === 0 ? "connecting" : "reconnecting");

      const ws = new WebSocket(websocketUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;

        const rawMessage = String(event.data);

        try {
          const message: WsChannelServerMessage = JSON.parse(rawMessage);

          // Only deduplicate `event` messages (replay protection on reconnect).
          // Protocol messages (connected, subscribed, pong, etc.) must always be
          // processed — they are idempotent and may recur legitimately after
          // reconnections or React Strict Mode effect re-runs.
          if (message.type === "event") {
            if (!rememberWsMessage(seenMessagesRef.current, rawMessage)) {
              return;
            }
          }

          // On the "connected" handshake, (re-)subscribe all registered channels.
          if (message.type === "connected") {
            subscribeAll(ws);
            return;
          }

          // Route channel-tagged messages to the appropriate handlers.
          // The server uses prefix matching (subscription "terminals" matches
          // event channel "terminals:term-123"), so we mirror that here.
          const channel = getMessageChannel(message);
          if (channel) {
            for (const [subChannel, sub] of channelSubsRef.current) {
              if (channelMatches(subChannel, channel)) {
                for (const handler of sub.handlers) {
                  handler(message);
                }
              }
            }
          }
        } catch {
          // Ignore malformed messages from the runtime host.
        }
      };

      ws.onclose = () => {
        const wasCurrent = wsRef.current === ws;
        if (wasCurrent) {
          wsRef.current = null;
        }

        if (disposed || !wasCurrent) return;

        reconnectAttemptsRef.current++;
        if (reconnectAttemptsRef.current > 5) {
          setConnectionState("disconnected");
          return;
        }

        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 16_000);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          openWebSocket();
        }, delay);
      };
    };

    openWebSocket();

    return () => {
      disposed = true;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.close();
      }
    };
  }, [websocketUrl]);

  const subscribe = useCallback(
    (
      channel: string,
      handler: ChannelMessageHandler,
      opts?: { getSince?: () => number },
    ): (() => void) => {
      let sub = channelSubsRef.current.get(channel);
      const isNew = !sub;
      if (!sub) {
        sub = { handlers: new Set(), getSince: opts?.getSince };
        channelSubsRef.current.set(channel, sub);
      }
      sub.handlers.add(handler);

      // If the channel was just created and we're already connected, subscribe now.
      if (isNew) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const since = opts?.getSince?.();
          const msg: WsChannelControlMessage = {
            action: "subscribe",
            channel,
            ...(since ? { since } : {}),
          };
          ws.send(JSON.stringify(msg));
        }
      }

      return () => {
        const currentSub = channelSubsRef.current.get(channel);
        if (!currentSub) return;
        currentSub.handlers.delete(handler);
        if (currentSub.handlers.size === 0) {
          channelSubsRef.current.delete(channel);
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "unsubscribe", channel }));
          }
        }
      };
    },
    [],
  );

  const send = useCallback((message: WsChannelControlMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }, []);

  return useMemo(
    () => ({ connectionState, subscribe, send }),
    [connectionState, subscribe, send],
  );
}

/**
 * Mirrors the Go server's `channelMatches` — a subscription to "terminals"
 * matches event channels "terminals" (exact) and "terminals:term-123" (prefix).
 */
function channelMatches(subscription: string, eventChannel: string): boolean {
  return subscription === eventChannel || eventChannel.startsWith(subscription + ":");
}

function getMessageChannel(message: WsChannelServerMessage): string | undefined {
  switch (message.type) {
    case "event":
      return message.channel;
    case "error":
      return message.channel;
    case "subscribed":
      return message.channel;
    case "unsubscribed":
      return message.channel;
    default:
      return undefined;
  }
}
