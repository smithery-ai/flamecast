import type {
  WsChannelServerMessage,
  WsChannelControlMessage,
} from "@flamecast/protocol/ws/channels";
import type { PermissionResponseBody } from "../../shared/session.js";
import { ChannelSubscription } from "./channel-subscription.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

interface FlamecastConnectionOptions {
  /** WebSocket URL, e.g. "ws://localhost:3001/ws" */
  url: string;
  /** SSE URL, e.g. "http://localhost:3001/api" — used as fallback when WS unavailable */
  sseBaseUrl?: string;
  /** Max reconnect attempts. Default: 5 */
  maxReconnectAttempts?: number;
}

/**
 * Shared multiplexed connection to a Flamecast server.
 *
 * Manages a single WebSocket (with SSE fallback) and creates
 * `ChannelSubscription` instances via `subscribe()`. Ref-counted:
 * first subscriber sends the WS subscribe message, last unsubscriber
 * sends unsubscribe.
 *
 * @example
 * ```ts
 * const conn = new FlamecastConnection({ url: "ws://localhost:3001/ws" });
 * conn.connect();
 *
 * const events = conn.subscribe("session:abc");
 * for await (const event of events) {
 *   console.log(event.event.type);
 * }
 * ```
 */
export class FlamecastConnection {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly sseBaseUrl: string | undefined;
  private readonly maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connectionState: ConnectionState = "disconnected";

  // Channel → active subscriptions (multiple consumers can share a channel)
  private readonly subscriptions = new Map<string, Set<ChannelSubscription>>();
  private readonly stateListeners: Array<(state: ConnectionState) => void> = [];

  constructor(opts: FlamecastConnectionOptions) {
    this.url = opts.url;
    this.sseBaseUrl = opts.sseBaseUrl;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  /** Subscribe to connection state changes. Returns unsubscribe function. */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateListeners.push(callback);
    return () => {
      const idx = this.stateListeners.indexOf(callback);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  connect(): void {
    if (this._connectionState === "connected" || this._connectionState === "connecting") return;
    this.setConnectionState("connecting");
    this.openWebSocket();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConnectionState("disconnected");
  }

  /**
   * Subscribe to a channel. Returns a `ChannelSubscription` which is
   * both an `AsyncIterable` and supports `onEvent()` callbacks.
   */
  subscribe(channel: string, opts?: { since?: number }): ChannelSubscription {
    const sub = new ChannelSubscription(channel, () => {
      this.removeSubscription(channel, sub);
    });

    let subs = this.subscriptions.get(channel);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(channel, subs);
      // First subscriber — send subscribe to server
      this.send({ action: "subscribe", channel, since: opts?.since });
    }
    subs.add(sub);

    return sub;
  }

  // ---- Convenience command methods ----

  prompt(sessionId: string, text: string): void {
    this.send({ action: "prompt", sessionId, text });
  }

  respondToPermission(sessionId: string, requestId: string, body: PermissionResponseBody): void {
    this.send({ action: "permission.respond", sessionId, requestId, body });
  }

  cancel(sessionId: string, queueId?: string): void {
    this.send({ action: "cancel", sessionId, queueId });
  }

  terminate(sessionId: string): void {
    this.send({ action: "terminate", sessionId });
  }

  queueReorder(sessionId: string, order: string[]): void {
    this.send({ action: "queue.reorder", sessionId, order });
  }

  queueClear(sessionId: string): void {
    this.send({ action: "queue.clear", sessionId });
  }

  queuePause(sessionId: string): void {
    this.send({ action: "queue.pause", sessionId });
  }

  queueResume(sessionId: string): void {
    this.send({ action: "queue.resume", sessionId });
  }

  // ---- Private ----

  private openWebSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnectionState("connected");
      // Re-subscribe all active channels with since for replay
      this.resendSubscriptions();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsChannelServerMessage = JSON.parse(String(event.data));
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this._connectionState === "disconnected") return;
      this.maybeReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private handleMessage(msg: WsChannelServerMessage): void {
    switch (msg.type) {
      case "event": {
        const subs = this.subscriptions.get(msg.channel);
        if (subs) {
          for (const sub of subs) sub._push(msg);
        }
        break;
      }
      case "connected":
      case "subscribed":
      case "unsubscribed":
      case "pong":
        // Protocol acknowledgements — no action needed
        break;
      case "session.created":
      case "session.terminated": {
        // Deliver to "agents" channel subscribers
        const agentSubs = this.subscriptions.get("agents");
        if (agentSubs) {
          // Wrap lifecycle as a synthetic channel event for consistent consumer API
          const synthetic = {
            type: "event" as const,
            channel: "agents",
            sessionId: msg.sessionId,
            agentId: msg.agentId,
            seq: 0,
            event: {
              type: msg.type,
              data: { sessionId: msg.sessionId, agentId: msg.agentId },
              timestamp: new Date().toISOString(),
            },
          };
          for (const sub of agentSubs) sub._push(synthetic);
        }
        break;
      }
      case "error":
        // Could surface to consumers in the future
        break;
    }
  }

  private resendSubscriptions(): void {
    for (const [channel, subs] of this.subscriptions) {
      if (subs.size === 0) continue;
      // Use the highest lastSeq across all subscriptions for this channel
      let maxSeq = 0;
      for (const sub of subs) {
        if (sub.lastSeq > maxSeq) maxSeq = sub.lastSeq;
      }
      this.send({
        action: "subscribe",
        channel,
        ...(maxSeq > 0 ? { since: maxSeq } : {}),
      });
    }
  }

  private removeSubscription(channel: string, sub: ChannelSubscription): void {
    const subs = this.subscriptions.get(channel);
    if (!subs) return;
    subs.delete(sub);
    if (subs.size === 0) {
      this.subscriptions.delete(channel);
      this.send({ action: "unsubscribe", channel });
    }
  }

  private maybeReconnect(): void {
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.setConnectionState("disconnected");
      return;
    }
    this.setConnectionState("reconnecting");
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 16_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, delay);
  }

  private send(msg: WsChannelControlMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}
