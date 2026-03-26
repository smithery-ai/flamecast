import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  WsChannelServerMessage,
  WsChannelControlMessage,
} from "@flamecast/protocol/ws/channels";
import type { EventBus } from "./event-bus.js";
import {
  eventToChannels,
  toWsChannelEvent,
  isTerminalChannelEvent,
  isQueueChannelEvent,
  isFsChannelEvent,
  type ChannelEvent,
} from "./channel-router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any HTTP server that supports the `upgrade` event. */
interface UpgradeableServer {
  on(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): this;
  off(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): this;
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
}

/** Methods the adapter needs from the Flamecast control plane. */
export interface WsAdapterFlamecast {
  promptSession(id: string, text: string): Promise<unknown>;
  terminateSession(id: string): Promise<void>;
  resolvePermission(
    sessionId: string,
    requestId: string,
    body: { optionId: string } | { outcome: "cancelled" },
  ): Promise<unknown>;
  proxyQueueRequest(id: string, path: string, init: RequestInit): Promise<Response>;
}

interface WsAdapterOptions {
  server: UpgradeableServer;
  path?: string;
  eventBus: EventBus;
  flamecast: WsAdapterFlamecast;
  maxSubscriptionsPerConnection?: number;
}

// ---------------------------------------------------------------------------
// WsAdapter — the multiplexed WS endpoint at ws://host/ws
// ---------------------------------------------------------------------------

export class WsAdapter {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ClientConnection>();
  private readonly channelToClients = new Map<string, Set<string>>();
  private readonly eventBus: EventBus;
  private readonly flamecast: WsAdapterFlamecast;
  private readonly maxSubscriptions: number;
  private readonly cleanups: Array<() => void> = [];

  constructor(opts: WsAdapterOptions) {
    const wsPath = opts.path ?? "/ws";
    this.eventBus = opts.eventBus;
    this.flamecast = opts.flamecast;
    this.maxSubscriptions = opts.maxSubscriptionsPerConnection ?? 100;

    this.wss = new WebSocketServer({ noServer: true });

    // Handle HTTP upgrade at the configured path
    const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === wsPath) {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.handleConnection(ws);
        });
      }
      // Other paths pass through (backward compat for per-session WS)
    };
    opts.server.on("upgrade", onUpgrade);
    this.cleanups.push(() => opts.server.off("upgrade", onUpgrade));

    // Subscribe to session events from the bridge
    const unsubEvent = this.eventBus.onEvent((event) => this.routeEvent(event));
    this.cleanups.push(unsubEvent);

    // Subscribe to lifecycle events for broadcast
    const unsubCreated = this.eventBus.onSessionCreated((payload) => {
      this.broadcastToChannel("agents", {
        type: "session.created",
        sessionId: payload.sessionId,
        agentId: payload.agentId,
      });
    });
    this.cleanups.push(unsubCreated);

    const unsubTerminated = this.eventBus.onSessionTerminated((payload) => {
      this.broadcastToChannel("agents", {
        type: "session.terminated",
        sessionId: payload.sessionId,
        agentId: payload.agentId,
      });
    });
    this.cleanups.push(unsubTerminated);
  }

  /** Gracefully close all connections and clean up. */
  close(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;

    for (const [, client] of this.clients) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.channelToClients.clear();
    this.wss.close();
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    const connectionId = randomUUID();
    const client: ClientConnection = {
      id: connectionId,
      ws,
      subscriptions: new Set(),
    };
    this.clients.set(connectionId, client);

    this.send(ws, { type: "connected", connectionId });

    ws.on("message", (data) => {
      try {
        const msg: WsChannelControlMessage = JSON.parse(String(data));
        this.handleMessage(client, msg);
      } catch {
        this.send(ws, { type: "error", message: "Invalid message format" });
      }
    });

    ws.on("close", () => {
      this.removeClient(connectionId);
    });
  }

  private async handleMessage(
    client: ClientConnection,
    msg: WsChannelControlMessage,
  ): Promise<void> {
    try {
      switch (msg.action) {
        case "subscribe":
          this.handleSubscribe(client, msg.channel, msg.since);
          break;
        case "unsubscribe":
          this.handleUnsubscribe(client, msg.channel);
          break;
        case "prompt":
          await this.flamecast.promptSession(msg.sessionId, msg.text);
          break;
        case "permission.respond":
          await this.flamecast.resolvePermission(msg.sessionId, msg.requestId, msg.body);
          break;
        case "cancel":
          // Cancel is proxied as a prompt queue cancel if queueId present,
          // otherwise it's a generic cancel (future: cancel running prompt)
          if (msg.queueId) {
            await this.flamecast.proxyQueueRequest(msg.sessionId, `/queue/${msg.queueId}`, {
              method: "DELETE",
            });
          }
          break;
        case "terminate":
          await this.flamecast.terminateSession(msg.sessionId);
          break;
        case "queue.reorder":
          await this.flamecast.proxyQueueRequest(msg.sessionId, "/queue", {
            method: "PUT",
            body: JSON.stringify({ order: msg.order }),
          });
          break;
        case "queue.clear":
          await this.flamecast.proxyQueueRequest(msg.sessionId, "/queue", { method: "DELETE" });
          break;
        case "queue.pause":
          await this.flamecast.proxyQueueRequest(msg.sessionId, "/queue/pause", {
            method: "POST",
          });
          break;
        case "queue.resume":
          await this.flamecast.proxyQueueRequest(msg.sessionId, "/queue/resume", {
            method: "POST",
          });
          break;
        case "ping":
          // No-op; the connection itself serves as heartbeat
          break;
      }
    } catch (error) {
      this.send(client.ws, {
        type: "error",
        message: error instanceof Error ? error.message : "Command failed",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // -------------------------------------------------------------------------

  private handleSubscribe(client: ClientConnection, channel: string, since?: number): void {
    // Idempotent — skip limit check if already subscribed
    if (!client.subscriptions.has(channel)) {
      if (client.subscriptions.size >= this.maxSubscriptions) {
        this.send(client.ws, {
          type: "error",
          message: `Max subscriptions (${this.maxSubscriptions}) exceeded`,
          channel,
        });
        return;
      }
      client.subscriptions.add(channel);

      // Update reverse index
      let clientSet = this.channelToClients.get(channel);
      if (!clientSet) {
        clientSet = new Set();
        this.channelToClients.set(channel, clientSet);
      }
      clientSet.add(client.id);
    }

    // Replay history AFTER adding to subscription (avoid race)
    this.replayHistory(client, channel, since);

    this.send(client.ws, { type: "subscribed", channel });
  }

  private handleUnsubscribe(client: ClientConnection, channel: string): void {
    client.subscriptions.delete(channel);
    const clientSet = this.channelToClients.get(channel);
    if (clientSet) {
      clientSet.delete(client.id);
      if (clientSet.size === 0) this.channelToClients.delete(channel);
    }
    this.send(client.ws, { type: "unsubscribed", channel });
  }

  private removeClient(connectionId: string): void {
    const client = this.clients.get(connectionId);
    if (!client) return;

    for (const channel of client.subscriptions) {
      const clientSet = this.channelToClients.get(channel);
      if (clientSet) {
        clientSet.delete(connectionId);
        if (clientSet.size === 0) this.channelToClients.delete(channel);
      }
    }
    this.clients.delete(connectionId);
  }

  // -------------------------------------------------------------------------
  // Event routing
  // -------------------------------------------------------------------------

  /**
   * Route an event to all subscribed clients. Each client receives the event
   * at most once, tagged with the most specific matching channel.
   */
  private routeEvent(event: ChannelEvent): void {
    const targetChannels = eventToChannels(event);
    const sentTo = new Set<string>();

    for (const channel of targetChannels) {
      const clientIds = this.channelToClients.get(channel);
      if (!clientIds) continue;

      for (const clientId of clientIds) {
        if (sentTo.has(clientId)) continue;
        sentTo.add(clientId);

        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) continue;

        // Tag with the most specific channel the client is subscribed to
        const matchedChannel = targetChannels.find((ch) => client.subscriptions.has(ch)) ?? channel;

        this.send(client.ws, toWsChannelEvent(event, matchedChannel));
      }
    }
  }

  // -------------------------------------------------------------------------
  // History replay
  // -------------------------------------------------------------------------

  private replayHistory(client: ClientConnection, channel: string, since?: number): void {
    // Extract sessionId from channel pattern
    const sessionId = this.extractSessionId(channel);
    if (!sessionId) return; // "agents" channel has no session history

    let events: ChannelEvent[];

    if (channel.endsWith(":queue")) {
      // Queue: replay only latest state snapshot
      const last = this.eventBus.getLastEvent(sessionId, isQueueChannelEvent);
      events = last ? [last] : [];
    } else if (channel.endsWith(":fs") || channel.includes(":fs")) {
      // FS: replay only latest snapshot
      const last = this.eventBus.getLastEvent(sessionId, isFsChannelEvent);
      events = last ? [last] : [];
    } else if (channel.includes(":terminal")) {
      // Terminal: replay terminal events
      events = this.eventBus.getHistory(sessionId, {
        since,
        filter: isTerminalChannelEvent,
      });
    } else {
      // Session or agent level: replay all events
      events = this.eventBus.getHistory(sessionId, { since });
    }

    for (const event of events) {
      if (client.ws.readyState !== WebSocket.OPEN) break;
      this.send(client.ws, toWsChannelEvent(event, channel));
    }
  }

  private extractSessionId(channel: string): string | undefined {
    // "session:abc" → "abc"
    // "session:abc:terminal" → "abc"
    // "agent:abc" → "abc" (agentId === sessionId in 1:1 model)
    // "agent:abc:fs" → "abc"
    // "agents" → undefined
    if (channel === "agents") return undefined;

    const parts = channel.split(":");
    if (parts.length >= 2) return parts[1];
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  private broadcastToChannel(channel: string, msg: WsChannelServerMessage): void {
    const clientIds = this.channelToClients.get(channel);
    if (!clientIds) return;

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.ws.readyState === WebSocket.OPEN) {
        this.send(client.ws, msg);
      }
    }
  }

  private send(ws: WebSocket, msg: WsChannelServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
