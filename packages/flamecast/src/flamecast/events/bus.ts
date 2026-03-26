import type { ChannelEvent } from "./channels.js";

// ---------------------------------------------------------------------------
// Minimal edge-compatible pub/sub (replaces node:events EventEmitter)
// ---------------------------------------------------------------------------

type Listener<T> = (payload: T) => void;

class Emitter<T> {
  private listeners: Array<Listener<T>> = [];

  on(listener: Listener<T>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(payload: T): void {
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}

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

/**
 * Internal event bus for the WS adapter.
 *
 * Uses a minimal hand-rolled pub/sub (no node:events) so the Flamecast class
 * can be imported in edge runtimes (CF Workers, Vercel) without Node builtins.
 *
 * - Lifecycle events (`session.created`, `session.terminated`) trigger bridge
 *   connect/disconnect.
 * - Session events are stored in a per-session ring buffer for history replay
 *   on subscribe.
 * - Each event gets a per-session monotonic `seq` number.
 */
export class EventBus {
  private readonly eventEmitter = new Emitter<ChannelEvent>();
  private readonly createdEmitter = new Emitter<SessionCreatedPayload>();
  private readonly terminatedEmitter = new Emitter<SessionTerminatedPayload>();

  private readonly history = new Map<string, ChannelEvent[]>();
  private readonly seqCounters = new Map<string, number>();
  private readonly categoryCounts = new Map<string, Map<keyof EventBusHistoryCaps, number>>();
  private readonly caps: EventBusHistoryCaps;

  constructor(opts?: EventBusOptions) {
    this.caps = { ...DEFAULT_CAPS, ...opts?.historyCaps };
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  emitSessionCreated(payload: SessionCreatedPayload): void {
    this.createdEmitter.emit(payload);
  }

  emitSessionTerminated(payload: SessionTerminatedPayload): void {
    this.terminatedEmitter.emit(payload);
    this.clearHistory(payload.sessionId);
  }

  onSessionCreated(listener: (payload: SessionCreatedPayload) => void): () => void {
    return this.createdEmitter.on(listener);
  }

  onSessionTerminated(listener: (payload: SessionTerminatedPayload) => void): () => void {
    return this.terminatedEmitter.on(listener);
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
    this.eventEmitter.emit(full);
    return full;
  }

  onEvent(listener: (event: ChannelEvent) => void): () => void {
    return this.eventEmitter.on(listener);
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
      const event = buf[i];
      if (event && filter(event)) return event;
    }
    return undefined;
  }

  clearHistory(sessionId: string): void {
    this.history.delete(sessionId);
    this.seqCounters.delete(sessionId);
    this.categoryCounts.delete(sessionId);
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

    // O(1) category count tracking
    const category = this.categoryForEvent(event);
    let counts = this.categoryCounts.get(event.sessionId);
    if (!counts) {
      counts = new Map();
      this.categoryCounts.set(event.sessionId, counts);
    }
    const count = (counts.get(category) ?? 0) + 1;
    counts.set(category, count);

    // Evict oldest events of the same category when over cap
    const cap = this.caps[category];
    if (count > cap) {
      const excess = count - cap;
      let removed = 0;
      for (let i = 0; i < buf.length && removed < excess; i++) {
        if (this.categoryForEvent(buf[i]) === category) {
          buf.splice(i, 1);
          removed++;
          i--;
        }
      }
      counts.set(category, count - removed);
    }
  }

  private categoryForEvent(event: ChannelEvent | undefined): keyof EventBusHistoryCaps {
    if (!event) return "default";
    const type = event.event.type;
    const method =
      type === "rpc" && typeof event.event.data.method === "string"
        ? event.event.data.method
        : undefined;

    if (type.startsWith("terminal.") || (method && method.startsWith("terminal."))) {
      return "terminal";
    }

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

    if (type === "rpc" || type === "session_update") {
      return "rpc";
    }

    return "default";
  }
}
