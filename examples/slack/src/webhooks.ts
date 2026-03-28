/**
 * Receives Flamecast webhook events and routes them to Slack threads.
 *
 * Same verification pattern as examples/webhooks-and-signaling/webhook-receiver.ts.
 */
import { verifyWebhookSignature } from "@flamecast/protocol/verify";
import type { WebhookPayload } from "@flamecast/protocol";
import { sessionThreads } from "./bot.js";

export function createWebhookHandler(secret: string) {
  return async function handleWebhook(req: Request): Promise<Response> {
    const body = await req.text();
    const sig = req.headers.get("x-flamecast-signature");

    if (!sig || !verifyWebhookSignature(secret, body, sig)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload: WebhookPayload = JSON.parse(body);
    const { sessionId, event } = payload;

    const thread = sessionThreads.get(sessionId);
    if (!thread) {
      console.warn(`[webhook] No thread found for session ${sessionId}`);
      return new Response("OK");
    }

    switch (event.type) {
      case "end_turn": {
        const data = event.data as { promptResponse?: unknown };
        const response = data.promptResponse;
        if (typeof response === "string") {
          await thread.post(response);
        } else if (response && typeof response === "object") {
          await thread.post(JSON.stringify(response, null, 2));
        } else {
          await thread.post("_Agent completed._");
        }
        break;
      }

      case "error": {
        const data = event.data as { message?: string };
        const message = typeof data.message === "string" ? data.message : "Unknown error";
        await thread.post(`*Error:* ${message}`);
        break;
      }

      case "session_end": {
        await thread.post("_Agent session ended._");
        sessionThreads.delete(sessionId);
        break;
      }
    }

    return new Response("OK");
  };
}
