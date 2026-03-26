/**
 * Tests for WebhookDeliveryEngine — standalone webhook delivery with
 * HMAC signing, retry, ordering, and event filtering.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebhookDeliveryEngine } from "../src/flamecast/webhook-delivery.js";
import { verifyWebhookSignature } from "@flamecast/protocol/verify";
import type { WebhookConfig } from "@flamecast/protocol/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebhook(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: overrides.id ?? "wh-1",
    url: overrides.url ?? "https://example.com/webhook",
    secret: overrides.secret ?? "test-secret",
    events: overrides.events,
  };
}

/** Track fetch calls and return configurable responses. */
function mockFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let responseFactory: (url: string, attempt: number) => Response = () =>
    new Response("ok", { status: 200 });
  let callCount = 0;

  const original = globalThis.fetch;

  function install() {
    // Monkey-patch fetch — avoids type assertion issues with vi.fn
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const body = typeof init?.body === "string" ? init.body : "";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k] = v;
        } else {
          Object.assign(headers, h);
        }
      }
      calls.push({ url: urlStr, headers, body });
      return responseFactory(urlStr, callCount++);
    };
  }

  function restore() {
    globalThis.fetch = original;
  }

  return {
    calls,
    install,
    restore,
    setResponse(fn: (url: string, attempt: number) => Response) {
      responseFactory = fn;
    },
    /** Replace fetch with a custom implementation for this test. */
    setImpl(fn: (url: string, init?: RequestInit) => Promise<Response>) {
      Object.defineProperty(globalThis, "fetch", { value: fn, writable: true, configurable: true });
    },
    reset() {
      calls.length = 0;
      callCount = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebhookDeliveryEngine", () => {
  let engine: WebhookDeliveryEngine;
  let mock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    engine = new WebhookDeliveryEngine();
    mock = mockFetch();
    mock.install();
  });

  afterEach(() => {
    engine.clear();
    mock.restore();
  });

  // =========================================================================
  // Basic delivery
  // =========================================================================

  it("delivers to matching webhooks", async () => {
    const webhook = makeWebhook({ events: ["error", "session_end"] });

    await engine.deliver("sess-1", "error", { message: "boom" }, [webhook]);

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://example.com/webhook");

    const payload = JSON.parse(mock.calls[0].body);
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.event.type).toBe("error");
    expect(payload.event.data).toEqual({ message: "boom" });
    expect(payload.eventId).toBeTruthy();
    expect(payload.timestamp).toBeTruthy();
  });

  it("skips webhooks that don't match the event type", async () => {
    const webhook = makeWebhook({ events: ["permission_request"] });

    await engine.deliver("sess-1", "error", { message: "boom" }, [webhook]);

    expect(mock.calls).toHaveLength(0);
  });

  it("delivers to webhooks with no event filter (receives all)", async () => {
    const webhook = makeWebhook({ events: undefined });

    await engine.deliver("sess-1", "session_end", { exitCode: 0 }, [webhook]);

    expect(mock.calls).toHaveLength(1);
  });

  it("does nothing for empty webhooks array", async () => {
    await engine.deliver("sess-1", "error", { message: "boom" }, []);
    expect(mock.calls).toHaveLength(0);
  });

  it("delivers to multiple matching webhooks concurrently", async () => {
    const wh1 = makeWebhook({ id: "wh-1", url: "https://a.com/hook" });
    const wh2 = makeWebhook({ id: "wh-2", url: "https://b.com/hook" });

    await engine.deliver("sess-1", "error", { message: "boom" }, [wh1, wh2]);

    expect(mock.calls).toHaveLength(2);
    const urls = mock.calls.map((c) => c.url);
    expect(urls).toContain("https://a.com/hook");
    expect(urls).toContain("https://b.com/hook");
  });

  // =========================================================================
  // HMAC signing
  // =========================================================================

  it("signs payloads with HMAC-SHA256", async () => {
    const secret = "my-webhook-secret";
    const webhook = makeWebhook({ secret });

    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    expect(mock.calls).toHaveLength(1);
    const headers = mock.calls[0].headers;
    const signature = headers["X-Flamecast-Signature"];
    expect(signature).toMatch(/^sha256=[a-f0-9]+$/);

    // Verify the signature is correct using the protocol helper
    const body = mock.calls[0].body;
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it("sets all required headers", async () => {
    const webhook = makeWebhook();

    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    const headers = mock.calls[0].headers;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Flamecast-Signature"]).toBeTruthy();
    expect(headers["X-Flamecast-Event-Id"]).toBeTruthy();
    expect(headers["X-Flamecast-Session-Id"]).toBe("sess-1");
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  it("uses the same event ID across retries", async () => {
    let attempt = 0;
    mock.setResponse(() => {
      attempt++;
      if (attempt <= 2) return new Response("error", { status: 500 });
      return new Response("ok", { status: 200 });
    });

    const webhook = makeWebhook();
    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    expect(mock.calls.length).toBeGreaterThanOrEqual(3);

    // All attempts should have the same event ID
    const eventIds = mock.calls.map((c) => c.headers["X-Flamecast-Event-Id"]);
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(1);
  });

  // =========================================================================
  // Retry behavior
  // =========================================================================

  it("retries on 5xx responses", async () => {
    let attempt = 0;
    mock.setResponse(() => {
      attempt++;
      if (attempt === 1) return new Response("error", { status: 503 });
      return new Response("ok", { status: 200 });
    });

    const webhook = makeWebhook();
    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    expect(mock.calls.length).toBe(2);
  });

  it("does not retry on 4xx (except 429)", async () => {
    mock.setResponse(() => new Response("bad request", { status: 400 }));

    const webhook = makeWebhook();
    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    // Should stop after first attempt — 400 is permanent
    expect(mock.calls.length).toBe(1);
  });

  it("retries on 429", async () => {
    let attempt = 0;
    mock.setResponse(() => {
      attempt++;
      if (attempt === 1) return new Response("rate limited", { status: 429 });
      return new Response("ok", { status: 200 });
    });

    const webhook = makeWebhook();
    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    expect(mock.calls.length).toBe(2);
  });

  it("retries on network errors", async () => {
    let attempt = 0;
    mock.setImpl(async () => {
      attempt++;
      if (attempt === 1) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    });

    const webhook = makeWebhook();
    await engine.deliver("sess-1", "error", { message: "test" }, [webhook]);

    expect(attempt).toBe(2);
  });

  // =========================================================================
  // AbortSignal
  // =========================================================================

  it("cancels pending retries when signal is aborted", async () => {
    mock.setResponse(() => new Response("error", { status: 500 }));

    const ac = new AbortController();
    const webhook = makeWebhook();

    // Abort after a short delay
    setTimeout(() => ac.abort(), 50);

    await engine.deliver("sess-1", "error", { message: "test" }, [webhook], ac.signal);

    // Should have fewer than 5 attempts (aborted during retry delays)
    expect(mock.calls.length).toBeLessThan(5);
  });

  // =========================================================================
  // Ordering
  // =========================================================================

  it("serializes deliveries for the same session+webhook", async () => {
    const order: number[] = [];

    mock.setImpl(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const eventNum = body.event?.data?.seq ?? 0;
      const delay = eventNum === 1 ? 50 : 10;
      await new Promise((r) => setTimeout(r, delay));
      order.push(eventNum);
      return new Response("ok", { status: 200 });
    });

    const webhook = makeWebhook();

    // Fire two events without awaiting — they should still be serialized
    const p1 = engine.deliver("sess-1", "error", { seq: 1 }, [webhook]);
    const p2 = engine.deliver("sess-1", "error", { seq: 2 }, [webhook]);

    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]); // Must be in order, not [2, 1]
  });

  it("runs different sessions concurrently", async () => {
    const started: string[] = [];

    mock.setImpl(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      started.push(body.sessionId);
      await new Promise((r) => setTimeout(r, 30));
      return new Response("ok", { status: 200 });
    });

    const webhook = makeWebhook();

    const p1 = engine.deliver("sess-A", "error", { msg: "a" }, [webhook]);
    const p2 = engine.deliver("sess-B", "error", { msg: "b" }, [webhook]);

    await Promise.all([p1, p2]);

    // Both should start before either finishes (concurrent)
    expect(started.length).toBe(2);
    // Both sessions should appear in started (order may vary since concurrent)
    expect(started).toContain("sess-A");
    expect(started).toContain("sess-B");
  });

  it("runs different webhooks for the same session concurrently", async () => {
    const started: string[] = [];

    mock.setImpl(async (url: string) => {
      started.push(url);
      await new Promise((r) => setTimeout(r, 30));
      return new Response("ok", { status: 200 });
    });

    const wh1 = makeWebhook({ id: "wh-1", url: "https://a.com/hook" });
    const wh2 = makeWebhook({ id: "wh-2", url: "https://b.com/hook" });

    await engine.deliver("sess-1", "error", { msg: "test" }, [wh1, wh2]);

    expect(started).toHaveLength(2);
    expect(started).toContain("https://a.com/hook");
    expect(started).toContain("https://b.com/hook");
  });
});
