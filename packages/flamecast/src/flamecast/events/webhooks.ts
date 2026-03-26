const randomUUID = (): string => crypto.randomUUID();
import type { WebhookConfig } from "@flamecast/protocol/session";
import { signWebhookPayload } from "@flamecast/protocol/verify";

const RETRY_DELAYS = [0, 5_000, 30_000, 120_000, 600_000];
const DELIVERY_TIMEOUT = 10_000;

export class WebhookDeliveryEngine {
  // Per-(sessionId, webhookId) serial queues for ordering guarantee
  private queues = new Map<string, Promise<void>>();

  /**
   * Enqueue an event for delivery to all matching webhooks.
   * Fire-and-forget — errors are logged, never thrown.
   * Deliveries for the same (sessionId, webhookId) are serialized.
   */
  async deliver(
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>,
    webhooks: WebhookConfig[],
    signal?: AbortSignal,
  ): Promise<void> {
    const matching = webhooks.filter((w) => !w.events || w.events.some((e) => e === eventType));
    if (matching.length === 0) return;

    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const payload = {
      sessionId,
      eventId,
      timestamp,
      event: { type: eventType, data },
    };

    await Promise.allSettled(
      matching.map((webhook) => {
        const key = `${sessionId}:${webhook.id}`;
        return this.enqueue(key, () => this.deliverToWebhook(webhook, payload, signal));
      }),
    );
  }

  /** Clear all queues (e.g. on shutdown). */
  clear(): void {
    this.queues.clear();
  }

  private enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next);
    // Clean up completed entries to prevent memory leak
    next.then(() => {
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    });
    return next;
  }

  private async deliverToWebhook(
    webhook: WebhookConfig,
    payload: {
      sessionId: string;
      eventId: string;
      timestamp: string;
      event: { type: string; data: Record<string, unknown> };
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = signWebhookPayload(webhook.secret, body);

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (signal?.aborted) return;

      const delay = RETRY_DELAYS[attempt];
      if (delay > 0) {
        await this.sleep(delay, signal);
        if (signal?.aborted) return;
      }

      try {
        const resp = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Flamecast-Signature": signature,
            "X-Flamecast-Event-Id": payload.eventId,
            "X-Flamecast-Session-Id": payload.sessionId,
          },
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT),
        });

        if (resp.ok) return; // Success

        // 429: retryable — respect Retry-After if present
        if (resp.status === 429) {
          const retryAfter = resp.headers.get("Retry-After");
          if (retryAfter) {
            const delaySec = parseInt(retryAfter, 10);
            if (!isNaN(delaySec) && delaySec > 0) {
              await this.sleep(delaySec * 1000, signal);
            }
          }
          continue;
        }

        // Other 4xx: permanent failure, don't retry
        if (resp.status >= 400 && resp.status < 500) {
          console.warn(
            `[Flamecast] Webhook delivery failed permanently (${resp.status}): ${webhook.url} [event=${payload.eventId}]`,
          );
          return;
        }

        // 5xx: retryable
        continue;
      } catch {
        // Network error or timeout — retryable
        continue;
      }
    }

    console.warn(
      `[Flamecast] Webhook delivery failed after ${RETRY_DELAYS.length} attempts: ${webhook.url} [event=${payload.eventId}]`,
    );
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
