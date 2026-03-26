import type { SessionLog, PermissionResponseBody } from "../../shared/session.js";
import type { WsServerMessage, WsControlMessage } from "@flamecast/protocol/ws";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

type FlamecastSessionOptions = {
  websocketUrl: string;
  sessionId: string;
  /** Max reconnect attempts before giving up. Default: 5 */
  maxReconnectAttempts?: number;
};

type EventCallback = (event: SessionLog) => void;

/** Derive the HTTP base URL from a WebSocket URL. */
function wsToHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):/, "http$1:");
}

/**
 * Client-side session that connects directly to a Flamecast
 * WebSocket endpoint for real-time events and control.
 *
 * File reads and filesystem snapshots are served over HTTP.
 * Real-time events (rpc, permissions, filesystem changes) are streamed over WS.
 */
export class FlamecastSession {
  readonly sessionId: string;
  private readonly websocketUrl: string;
  private readonly httpUrl: string;
  private readonly maxReconnectAttempts: number;

  private ws: WebSocket | null = null;
  private _connectionState: ConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<EventCallback>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly eventBuffer: SessionLog[] = [];

  constructor(opts: FlamecastSessionOptions) {
    this.sessionId = opts.sessionId;
    this.websocketUrl = opts.websocketUrl;
    this.httpUrl = wsToHttpUrl(opts.websocketUrl);
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
  }

  /** Current connection state. */
  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  /** All events received during this session's lifetime. */
  get events(): readonly SessionLog[] {
    return this.eventBuffer;
  }

  /** Open the WebSocket connection. */
  connect(): void {
    if (this.ws) return;
    this.setConnectionState("connecting");
    this.openWebSocket();
  }

  /** Close the WebSocket connection. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // prevent auto-reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConnectionState("disconnected");
  }

  /** Subscribe to session events. Returns an unsubscribe function. */
  on(callback: EventCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Subscribe to connection state changes. */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /** Send a prompt to the agent. */
  prompt(text: string): void {
    this.sendControl({ action: "prompt", text });
  }

  /** Respond to a permission request. */
  respondToPermission(requestId: string, body: PermissionResponseBody): void {
    this.sendControl({ action: "permission.respond", requestId, body });
  }

  /** Cancel a queued prompt. */
  cancel(queueId?: string): void {
    this.sendControl({ action: "cancel", queueId });
  }

  /** Terminate the session. */
  terminate(): void {
    this.sendControl({ action: "terminate" });
  }

  /** Fetch a file preview over HTTP. */
  async requestFilePreview(
    filePath: string,
  ): Promise<{ content: string; truncated: boolean; maxChars: number }> {
    const resp = await fetch(`${this.httpUrl}/files?path=${encodeURIComponent(filePath)}`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(body.error ?? `Failed to fetch file: ${resp.status}`);
    }
    return resp.json();
  }

  /** Fetch the filesystem snapshot over HTTP. */
  async requestFsSnapshot(): Promise<{
    root: string;
    entries: Array<{ path: string; type: string }>;
    truncated: boolean;
    maxEntries: number;
  }> {
    const resp = await fetch(`${this.httpUrl}/fs/snapshot`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(body.error ?? `Failed to fetch snapshot: ${resp.status}`);
    }
    return resp.json();
  }

  // ---- Private ----

  private openWebSocket(): void {
    const ws = new WebSocket(this.websocketUrl);

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnectionState("connected");
      console.log("[FlamecastSession] WS connected to", this.websocketUrl);
    };

    ws.onmessage = (event) => {
      this.handleMessage(String(event.data));
    };

    ws.onclose = (event) => {
      console.log("[FlamecastSession] WS closed", event.code, event.reason);
      this.ws = null;
      if (this._connectionState !== "disconnected") {
        this.attemptReconnect();
      }
    };

    ws.onerror = (event) => {
      console.error("[FlamecastSession] WS error", event);
    };

    this.ws = ws;
  }

  private handleMessage(data: string): void {
    try {
      const msg: WsServerMessage = JSON.parse(data);

      if (msg.type === "event") {
        const sessionEvent: SessionLog = {
          type: msg.event.type,
          timestamp: msg.event.timestamp,
          data: msg.event.data,
        };
        console.log(
          "[FlamecastSession] event:",
          sessionEvent.type,
          JSON.stringify(sessionEvent.data).slice(0, 200),
        );
        this.eventBuffer.push(sessionEvent);
        for (const listener of this.listeners) {
          try {
            listener(sessionEvent);
          } catch {
            // Listener errors must not disrupt
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private sendControl(msg: WsControlMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setConnectionState("disconnected");
      return;
    }

    this.setConnectionState("reconnecting");
    this.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, delay);
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // State listener errors must not disrupt
      }
    }
  }
}
