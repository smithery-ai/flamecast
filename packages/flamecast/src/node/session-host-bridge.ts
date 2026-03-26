import WebSocket from "ws";
import type { WsServerMessage } from "@flamecast/protocol/ws";
import { resolveAgentId } from "../flamecast/events/channels.js";
import type { EventBus } from "../flamecast/events/bus.js";

// ---------------------------------------------------------------------------
// SessionHostBridge
//
// Manages read-only WS connections from the control plane to each active
// session-host. Events received on these connections are pushed into the
// EventBus for routing to browser clients via the WsAdapter.
// ---------------------------------------------------------------------------

interface BridgeConnection {
  ws: WebSocket;
  sessionId: string;
  attempts: number;
  terminated: boolean;
}

interface SessionHostBridgeOptions {
  eventBus: EventBus;
  /** Maximum reconnect attempts before giving up (default: 5). */
  maxReconnectAttempts?: number;
}

export class SessionHostBridge {
  private readonly connections = new Map<string, BridgeConnection>();
  private readonly terminatedSessions = new Set<string>();
  private readonly eventBus: EventBus;
  private readonly maxReconnectAttempts: number;
  private readonly terminatedUnsubscribe: () => void;

  constructor(opts: SessionHostBridgeOptions) {
    this.eventBus = opts.eventBus;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;

    // Listen for session termination to stop reconnecting
    this.terminatedUnsubscribe = this.eventBus.onSessionTerminated(({ sessionId }) => {
      this.terminatedSessions.add(sessionId);
      const conn = this.connections.get(sessionId);
      if (conn) {
        conn.terminated = true;
        conn.ws.close();
        this.connections.delete(sessionId);
      }
    });
  }

  /**
   * Open a read-only WS connection to a session-host.
   * Called when a new session is created.
   */
  connect(sessionId: string, websocketUrl: string): void {
    if (this.connections.has(sessionId)) return;
    this.openConnection(sessionId, websocketUrl, 0);
  }

  /**
   * Close the connection for a session.
   * Called on session termination.
   */
  disconnect(sessionId: string): void {
    const conn = this.connections.get(sessionId);
    if (!conn) return;
    conn.terminated = true;
    conn.ws.close();
    this.connections.delete(sessionId);
  }

  /**
   * Close all connections. Called on Flamecast.shutdown().
   */
  disconnectAll(): void {
    for (const [, conn] of this.connections) {
      conn.terminated = true;
      conn.ws.close();
    }
    this.connections.clear();
    this.terminatedUnsubscribe();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private openConnection(sessionId: string, websocketUrl: string, attempts: number): void {
    const ws = new WebSocket(websocketUrl);
    const conn: BridgeConnection = { ws, sessionId, attempts, terminated: false };
    this.connections.set(sessionId, conn);

    ws.on("message", (data) => {
      try {
        const msg: WsServerMessage = JSON.parse(String(data));
        this.handleMessage(sessionId, msg);
      } catch {
        // Ignore malformed messages from session-host
      }
    });

    ws.on("open", () => {
      // Reset attempt counter on successful connection
      conn.attempts = 0;
    });

    ws.on("close", () => {
      if (conn.terminated) return;
      this.maybeReconnect(sessionId, websocketUrl, conn.attempts);
    });

    ws.on("error", (err) => {
      console.warn(
        `[SessionHostBridge] WS error for "${sessionId}" (${websocketUrl}): ${err.message}`,
      );
    });
  }

  private handleMessage(sessionId: string, msg: WsServerMessage): void {
    // Ignore the session-host's initial handshake
    if (msg.type === "connected") return;

    if (msg.type === "error") {
      // Push error as a channel event
      this.eventBus.pushEvent({
        sessionId,
        agentId: resolveAgentId(sessionId),
        event: {
          type: "error",
          data: { message: msg.message },
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    if (msg.type === "event") {
      this.eventBus.pushEvent({
        sessionId,
        agentId: resolveAgentId(sessionId),
        event: msg.event,
      });
    }
  }

  private maybeReconnect(sessionId: string, websocketUrl: string, prevAttempts: number): void {
    this.connections.delete(sessionId);

    const nextAttempt = prevAttempts + 1;
    if (nextAttempt > this.maxReconnectAttempts) {
      console.warn(
        `[SessionHostBridge] Giving up reconnection for session "${sessionId}" after ${this.maxReconnectAttempts} attempts`,
      );
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at 16s)
    const delay = Math.min(1000 * Math.pow(2, prevAttempts), 16_000);
    setTimeout(() => {
      // Don't reconnect if the session was terminated during the backoff delay
      if (this.terminatedSessions.has(sessionId)) return;
      if (this.connections.has(sessionId)) return; // already reconnected
      this.openConnection(sessionId, websocketUrl, nextAttempt);
    }, delay);
  }
}
