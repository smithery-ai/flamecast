import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionLog } from "../shared/session.js";
import { WsControlMessageSchema, type WsServerMessage } from "../shared/ws-protocol.js";

export type WsSessionHandler = {
  hasSession(sessionId: string): boolean;
  terminateSession(sessionId: string): Promise<void>;
  // Phase 6: these methods are optional during migration — the sidecar will provide them.
  subscribe?(sessionId: string, callback: (event: SessionLog) => void): () => void;
  promptSession?(sessionId: string, text: string): Promise<unknown>;
  resolvePermission?(
    sessionId: string,
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ): Promise<void>;
  cancelQueuedPrompt?(sessionId: string, queueId: string): Promise<void>;
  readFileContent?(sessionId: string, path: string): Promise<{ content: string; truncated: boolean; maxChars: number }>;
};

/**
 * Manages WebSocket connections for session event streaming and control.
 * Attaches to an existing HTTP server via the `upgrade` event.
 */
export class FlamecastWsServer {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Set<WebSocket>>();
  private readonly unsubscribers = new Map<WebSocket, () => void>();

  constructor(private readonly handler: WsSessionHandler) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Handle an HTTP upgrade request. Call this from the server's `upgrade` event.
   * Expected URL pattern: /ws/sessions/:sessionId
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const match = url.pathname.match(/^\/ws\/sessions\/([^/]+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];

    if (!this.handler.hasSession(sessionId)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, sessionId);
    });
  }

  /** Clean up all connections. */
  close(): void {
    for (const [ws, unsubscribe] of this.unsubscribers) {
      unsubscribe();
      ws.close();
    }
    this.connections.clear();
    this.unsubscribers.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket, sessionId: string): void {
    // Track connection
    let sessionConns = this.connections.get(sessionId);
    if (!sessionConns) {
      sessionConns = new Set();
      this.connections.set(sessionId, sessionConns);
    }
    sessionConns.add(ws);

    // Send connected message
    console.log("[WS] Client connected for session", sessionId);
    this.send(ws, { type: "connected", sessionId });

    // Subscribe to session events (if handler supports it)
    console.log("[WS] handler.subscribe?", !!this.handler.subscribe, "handler.promptSession?", !!this.handler.promptSession);
    if (this.handler.subscribe) {
      const unsubscribe = this.handler.subscribe(sessionId, (event) => {
        this.send(ws, {
          type: "event",
          timestamp: new Date().toISOString(),
          event,
        });
      });
      this.unsubscribers.set(ws, unsubscribe);
    }

    // Handle incoming control messages
    ws.on("message", (data) => {
      void this.handleMessage(ws, sessionId, data);
    });

    // Handle disconnect
    ws.on("close", () => {
      this.removeConnection(ws, sessionId);
    });

    ws.on("error", () => {
      this.removeConnection(ws, sessionId);
    });
  }

  private async handleMessage(
    ws: WebSocket,
    sessionId: string,
    data: unknown,
  ): Promise<void> {
    try {
      const text = typeof data === "string" ? data : String(data);
      const parsed = JSON.parse(text);
      const result = WsControlMessageSchema.safeParse(parsed);

      if (!result.success) {
        this.send(ws, { type: "error", message: "Invalid control message" });
        return;
      }

      const msg = result.data;

      switch (msg.action) {
        case "prompt":
          if (!this.handler.promptSession) {
            throw new Error("Prompt not supported on this handler");
          }
          await this.handler.promptSession(sessionId, msg.text);
          break;

        case "permission.respond":
          if (!this.handler.resolvePermission) {
            throw new Error("Permission resolution not supported on this handler");
          }
          await this.handler.resolvePermission(sessionId, msg.requestId, msg.body);
          break;

        case "cancel":
          if (msg.queueId) {
            if (!this.handler.cancelQueuedPrompt) {
              throw new Error("Queue cancellation not supported on this handler");
            }
            await this.handler.cancelQueuedPrompt(sessionId, msg.queueId);
          }
          break;

        case "terminate":
          await this.handler.terminateSession(sessionId);
          break;

        case "ping":
          this.send(ws, { type: "connected", sessionId });
          break;

        case "file.preview": {
          if (!this.handler.readFileContent) {
            throw new Error("File preview not supported on this handler");
          }
          const result = await this.handler.readFileContent(sessionId, msg.path);
          this.send(ws, {
            type: "file.preview",
            path: msg.path,
            content: result.content,
            truncated: result.truncated,
            maxChars: result.maxChars,
          });
          break;
        }
      }
    } catch (error) {
      this.send(ws, {
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private send(ws: WebSocket, message: WsServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private removeConnection(ws: WebSocket, sessionId: string): void {
    const unsubscribe = this.unsubscribers.get(ws);
    if (unsubscribe) {
      unsubscribe();
      this.unsubscribers.delete(ws);
    }

    const sessionConns = this.connections.get(sessionId);
    if (sessionConns) {
      sessionConns.delete(ws);
      if (sessionConns.size === 0) {
        this.connections.delete(sessionId);
      }
    }
  }
}
