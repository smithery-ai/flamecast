import { createPubsubClient } from "@restatedev/pubsub-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mirrors the ChannelEvent shape from @flamecast/sdk's EventBus so the SSE
 * endpoint can consume events from either source without changes.
 */
export interface ChannelEvent {
  sessionId: string;
  agentId: string;
  seq: number;
  event: {
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
}

export interface PubsubSseConsumerOptions {
  /**
   * Restate ingress URL (e.g. "http://localhost:8080").
   */
  ingressUrl: string;
  /**
   * Name of the pubsub virtual object registered with Restate.
   * Must match the name used on the publisher side (typically "pubsub").
   */
  pubsubName?: string;
  /**
   * Optional headers sent with every request to the ingress (e.g. auth tokens).
   */
  headers?: Record<string, string>;
  /**
   * Pull interval in milliseconds. Defaults to 500ms for snappy SSE.
   */
  pullIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Normalize a raw pubsub message into a ChannelEvent
// ---------------------------------------------------------------------------

/**
 * The publisher in session-object.ts publishes plain objects like:
 *   { type: "session.created", sessionId: "..." }
 *   { type: "permission_request", data: { ... } }
 *   { type: "end_turn", data: { ... } }           (SessionCallbackEvent)
 *
 * We normalise these into the ChannelEvent shape expected by the SSE endpoint.
 */
function toChannelEvent(
  raw: Record<string, unknown>,
  sessionId: string,
  seq: number,
): ChannelEvent {
  const type = (raw.type as string) ?? "unknown";

  // The published object may carry its payload in `data`, or it may carry
  // top-level fields beside `type`.  Normalise both styles into `event.data`.
  let data: Record<string, unknown>;
  if (raw.data !== undefined && typeof raw.data === "object" && raw.data !== null) {
    data = raw.data as Record<string, unknown>;
  } else {
    // Clone and strip `type` — everything else is data
    const { type: _t, ...rest } = raw;
    data = rest as Record<string, unknown>;
  }

  return {
    sessionId,
    // In the current 1:1 model, agentId === sessionId
    agentId: sessionId,
    seq,
    event: {
      type,
      data,
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// PubsubSseConsumer
// ---------------------------------------------------------------------------

/**
 * Subscribes to a Restate pubsub topic and yields ChannelEvents.
 *
 * Designed as a drop-in data source for the SSE endpoint that currently uses
 * EventBus. The caller iterates over the async generator and writes each event
 * as an SSE frame.
 *
 * Usage:
 * ```ts
 * const consumer = new PubsubSseConsumer({ ingressUrl: "http://localhost:8080" });
 * const stream = consumer.subscribe("my-session-id", { since: 42 });
 * for await (const event of stream) {
 *   sseStream.writeSSE({ data: JSON.stringify(event), event: event.event.type, id: String(event.seq) });
 * }
 * ```
 */
export class PubsubSseConsumer {
  private readonly client: ReturnType<typeof createPubsubClient>;

  constructor(private readonly options: PubsubSseConsumerOptions) {
    this.client = createPubsubClient({
      name: options.pubsubName ?? "pubsub",
      ingressUrl: options.ingressUrl,
      pullInterval: { milliseconds: options.pullIntervalMs ?? 500 },
    });
  }

  /**
   * Subscribe to events for a session.
   *
   * @param sessionId  The session to subscribe to.
   * @param opts.since If provided, only events with offset > since are returned
   *                   (mirrors EventBus.getHistory's `since` semantics).
   * @param opts.signal AbortSignal to cancel the subscription.
   * @returns An async generator yielding ChannelEvents.
   */
  async *subscribe(
    sessionId: string,
    opts?: { since?: number; signal?: AbortSignal },
  ): AsyncGenerator<ChannelEvent, void, unknown> {
    const topic = `session:${sessionId}`;
    // pubsub-client's offset is 0-based and pulls messages *from* that offset.
    // EventBus `since` means "seq > since", so offset = since means "start
    // pulling from the message after `since`", which is correct because the
    // pubsub pull returns messages with offset >= requested offset and the
    // publisher assigns monotonic offsets.
    const offset = opts?.since ?? 0;

    const pull = this.client.pull({
      topic,
      offset,
      signal: opts?.signal,
    });

    // The pull generator yields raw published messages. We assign a local seq
    // counter that mirrors EventBus semantics. The seq starts from (offset + 1)
    // so it aligns with the offset used for reconnection via Last-Event-ID.
    let seq = offset;
    for await (const raw of pull) {
      seq++;
      yield toChannelEvent(raw as Record<string, unknown>, sessionId, seq);
    }
  }

  /**
   * Convenience: return a ReadableStream<Uint8Array> formatted as SSE.
   *
   * This uses the pubsub-client's built-in SSE stream but wraps each message
   * in the ChannelEvent-aware SSE format (with `event:` and `id:` fields)
   * expected by the Flamecast frontend.
   */
  sseStream(
    sessionId: string,
    opts?: { since?: number; signal?: AbortSignal },
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const generator = this.subscribe(sessionId, opts);

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of generator) {
            const sseFrame = [
              `id: ${event.seq}`,
              `event: ${event.event.type}`,
              `data: ${JSON.stringify(event)}`,
              "",
              "", // double newline terminates the SSE frame
            ].join("\n");
            controller.enqueue(encoder.encode(sseFrame));
          }
          controller.close();
        } catch (error) {
          // AbortError is expected when the client disconnects
          if (error instanceof DOMException && error.name === "AbortError") {
            controller.close();
          } else {
            controller.error(error);
          }
        }
      },
      cancel() {
        // Signal the async generator to stop
        generator.return(undefined);
      },
    });
  }
}
