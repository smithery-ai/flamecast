import { EventEmitter } from "node:events";
import type { ChannelEvent } from "./channel-router.js";

// ---------------------------------------------------------------------------
// Per-category history buffer caps
// ---------------------------------------------------------------------------

interface EventBusHistoryCaps {
  /** Default cap for unclassified events. */
  default: number;
  /** Cap for terminal events (high-frequency output). */
  terminal: number;
  /** Cap for RPC / conversation events (streaming tokens). */
  rpc: number;
  /** Cap for queue + filesystem events (low-frequency snapshots). */
  snapshot: number;
}

const DEFAULT_CAPS: EventBusHistoryCaps = {
  default: 1000,
  terminal: 5000,
  rpc: 2000,
  snapshot: 100,
};

interface EventBusOptions {
  historyCaps?: Partial<EventBusHistoryCaps>;
}

// ---------------------------------------------------------------------------
// Lifecycle event payloads
// ---------------------------------------------------------------------------

interface SessionCreatedPayload {
  sessionId: string;
  agentId: string;
  websocketUrl: string;
}

interface SessionTerminatedPayload {
  sessionId: string;
  agentId: string;
}

// ---------------------------------------------------------------------------
// EventBus — lifecycle pub/sub + per-session event history
// ---------------------------------------------------------------------------

type EventListener = (event: ChannelEvent) => void;
type SessionCreatedListener = (payload: SessionCreatedPayload) => void;
type SessionTerminatedListener = (payload: SessionTerminatedPayload) => void;

/**
 * Internal event bus for the WS adapter.
 *
 * - Lifecycle events (`session.created`, `session.terminated`) trigger bridge
 *   connect/disconnect.
 * - Session events are stored in a per-session ring buffer for history replay
 *   on subscribe.
 * - Each event gets a per-session monotonic `seq` number.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history = new Map<string, ChannelEvent[]>();
  private readonly seqCounters = new Map<string, number>();
  private readonly caps: EventBusHistoryCaps;

  constructor(opts?: EventBusOptions) {
    this.caps = { ...DEFAULT_CAPS, ...opts?.historyCaps };
    this.emitter.setMaxListeners(0);
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  emitSessionCreated(payload: SessionCreatedPayload): void {
    this.emitter.emit("session.created", payload);
  }

  emitSessionTerminated(payload: SessionTerminatedPayload): void {
    this.emitter.emit("session.terminated", payload);
    this.clearHistory(payload.sessionId);
  }

  onSessionCreated(listener: SessionCreatedListener): () => void {
    this.emitter.on("session.created", listener);
    return () => this.emitter.off("session.created", listener);
  }

  onSessionTerminated(listener: SessionTerminatedListener): () => void {
    this.emitter.on("session.terminated", listener);
    return () => this.emitter.off("session.terminated", listener);
  }

  // -------------------------------------------------------------------------
  // Session events (from SessionHostBridge)
  // -------------------------------------------------------------------------

  /**
   * Push an event into the bus. Assigns a monotonic `seq` number and stores
   * in the history ring buffer.
   */
  pushEvent(event: Omit<ChannelEvent, "seq">): ChannelEvent {
    const seq = this.nextSeq(event.sessionId);
    const full: ChannelEvent = { ...event, seq };
    this.appendHistory(full);
    this.emitter.emit("event", full);
    return full;
  }

  onEvent(listener: EventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * Get history for a session, optionally filtered. If `since` is provided,
   * only events with `seq > since` are returned.
   */
  getHistory(
    sessionId: string,
    opts?: { filter?: (e: ChannelEvent) => boolean; since?: number },
  ): ChannelEvent[] {
    const buf = this.history.get(sessionId);
    if (!buf) return [];

    let events = buf;
    if (opts?.since !== undefined) {
      const since = opts.since;
      events = events.filter((e) => e.seq > since);
    }
    if (opts?.filter) {
      events = events.filter(opts.filter);
    }
    return events;
  }

  /**
   * Get only the last event matching a filter (useful for snapshot channels
   * like queue and fs that only need the latest state).
   */
  getLastEvent(sessionId: string, filter: (e: ChannelEvent) => boolean): ChannelEvent | undefined {
    const buf = this.history.get(sessionId);
    if (!buf) return undefined;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (filter(buf[i]!)) return buf[i];
    }
    return undefined;
  }

  clearHistory(sessionId: string): void {
    this.history.delete(sessionId);
    this.seqCounters.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private nextSeq(sessionId: string): number {
    const current = this.seqCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.seqCounters.set(sessionId, next);
    return next;
  }

  private appendHistory(event: ChannelEvent): void {
    let buf = this.history.get(event.sessionId);
    if (!buf) {
      buf = [];
      this.history.set(event.sessionId, buf);
    }

    buf.push(event);

    // Enforce per-category cap: count only events of the same category,
    // and evict oldest events of that category when over cap. This prevents
    // a single low-cap event (e.g. queue) from evicting unrelated events (e.g. RPC).
    const category = this.categoryForEvent(event);
    const cap = this.caps[category];
    let categoryCount = 0;
    for (const e of buf) {
      if (this.categoryForEvent(e) === category) categoryCount++;
    }

    if (categoryCount > cap) {
      const excess = categoryCount - cap;
      let removed = 0;
      for (let i = 0; i < buf.length && removed < excess; i++) {
        if (this.categoryForEvent(buf[i]) === category) {
          buf.splice(i, 1);
          removed++;
          i--; // adjust index after splice
        }
      }
    }
  }

  private categoryForEvent(event: ChannelEvent): keyof EventBusHistoryCaps {
    const type = event.event.type;
    const method =
      type === "rpc" && typeof event.event.data.method === "string"
        ? event.event.data.method
        : undefined;

    // Terminal events
    if (type.startsWith("terminal.") || (method && method.startsWith("terminal."))) {
      return "terminal";
    }

    // Queue / FS snapshot events
    if (
      type.startsWith("queue.") ||
      type.startsWith("filesystem.") ||
      type === "file.preview" ||
      (method &&
        (method.startsWith("queue.") ||
          method.startsWith("filesystem.") ||
          method === "file.preview"))
    ) {
      return "snapshot";
    }

    // RPC (streaming tokens, tool calls, etc.)
    if (type === "rpc" || type === "session_update") {
      return "rpc";
    }

    return "default";
  }
}
