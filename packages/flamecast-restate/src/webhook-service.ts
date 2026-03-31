import * as restate from "@restatedev/restate-sdk";
import { createHmac } from "node:crypto";
import type { WebhookConfig } from "@flamecast/protocol/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hmacSha256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

interface WebhookDeliveryInput {
  webhook: WebhookConfig;
  sessionId: string;
  event: { type: string; data: unknown };
}

// ---------------------------------------------------------------------------
// WebhookDeliveryService — stateless Restate service for durable webhook
// delivery.  Fire-and-forget from FlamecastSession via
// ctx.serviceSendClient().
// ---------------------------------------------------------------------------

export const WebhookDeliveryService = restate.service({
  name: "WebhookDelivery",
  handlers: {
    deliver: async (ctx: restate.Context, input: WebhookDeliveryInput) => {
      const { webhook, sessionId, event } = input;
      const now = new Date(await ctx.date.now()).toISOString();

      const body = JSON.stringify({
        sessionId,
        event: { type: event.type, data: event.data },
        timestamp: now,
      });
      const signature = hmacSha256(webhook.secret, body);

      await ctx.run(
        "deliver",
        async () => {
          const resp = await fetch(webhook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Flamecast-Signature": signature,
            },
            body,
          });

          if (resp.status >= 400 && resp.status < 500) {
            throw new restate.TerminalError(
              `Webhook rejected: ${resp.status}`,
            );
          }
          if (!resp.ok) {
            throw new Error(`Webhook failed: ${resp.status}`);
          }
        },
        {
          maxRetryAttempts: 5,
          initialRetryInterval: { seconds: 5 },
          retryIntervalFactor: 6,
        },
      );
    },
  },
});

export type WebhookDeliveryServiceApi = typeof WebhookDeliveryService;
