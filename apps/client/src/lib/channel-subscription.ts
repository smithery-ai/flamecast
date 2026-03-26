import type { WsChannelEventMessage } from "@flamecast/protocol/ws/channels";

// Shared done result — avoids `as` casts throughout the iterator
const DONE: IteratorReturnResult<undefined> = { value: undefined, done: true };

/**
 * A channel subscription — the core primitive for consuming events.
 *
 * Implements `AsyncIterable<WsChannelEventMessage>` for `for await...of` usage
 * in vanilla JS/TS, and exposes `onEvent()` for React hooks using
 * `useSyncExternalStore`.
 *
 * @example
 * ```ts
 * // Vanilla JS — async iteration
 * const sub = connection.subscribe("session:abc");
 * for await (const event of sub) {
 *   console.log(event.event.type, event.event.data);
 * }
 *
 * // React hooks use onEvent() internally
 * sub.onEvent((event) => { ... });
 * ```
 */
export class ChannelSubscription implements AsyncIterable<WsChannelEventMessage> {
  readonly channel: string;

  private readonly listeners: Array<(event: WsChannelEventMessage) => void> = [];
  private readonly queue: WsChannelEventMessage[] = [];
  private waiting:
    | ((
        result: IteratorYieldResult<WsChannelEventMessage> | IteratorReturnResult<undefined>,
      ) => void)
    | null = null;
  private closed = false;
  private _lastSeq = 0;

  /** Called by FlamecastConnection when unsubscribing from the server. */
  readonly _onClose: () => void;

  constructor(channel: string, onClose: () => void) {
    this.channel = channel;
    this._onClose = onClose;
  }

  /** The last seq number received on this subscription. Used for reconnection. */
  get lastSeq(): number {
    return this._lastSeq;
  }

  /** Push an event into the subscription (called by FlamecastConnection). */
  _push(event: WsChannelEventMessage): void {
    if (this.closed) return;
    if (event.seq > this._lastSeq) this._lastSeq = event.seq;

    // Notify callback listeners
    for (const listener of this.listeners) {
      listener(event);
    }

    // Feed the async iterator
    if (this.waiting) {
      this.waiting({ value: event, done: false });
      this.waiting = null;
    } else {
      this.queue.push(event);
    }
  }

  /**
   * Subscribe with a callback. Returns an unsubscribe function.
   * Used by React hooks with `useSyncExternalStore`.
   */
  onEvent(callback: (event: WsChannelEventMessage) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Close the subscription. Signals the async iterator to end and
   * sends an unsubscribe message to the server.
   */
  return(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      this.waiting(DONE);
      this.waiting = null;
    }
    this._onClose();
  }

  // AsyncIterable implementation
  [Symbol.asyncIterator](): AsyncIterator<WsChannelEventMessage, undefined> {
    return {
      next: (): Promise<IteratorResult<WsChannelEventMessage, undefined>> => {
        const shifted = this.queue.shift();
        if (shifted) {
          return Promise.resolve({ value: shifted, done: false });
        }
        if (this.closed) {
          return Promise.resolve(DONE);
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: (): Promise<IteratorReturnResult<undefined>> => {
        this.return();
        return Promise.resolve(DONE);
      },
    };
  }
}
