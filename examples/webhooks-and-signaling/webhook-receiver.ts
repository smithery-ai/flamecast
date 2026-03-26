/**
 * Minimal webhook receiver that logs signed events.
 * Simulates a Slack bot or external system receiving Flamecast webhooks.
 */
import { createServer, type Server } from "node:http";
import { verifyWebhookSignature } from "@flamecast/protocol/verify";

export function createWebhookReceiver(port: number, secret: string): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();

    const sig = req.headers["x-flamecast-signature"];
    const verified = typeof sig === "string" && verifyWebhookSignature(secret, body, sig);
    const payload = JSON.parse(body);

    console.log(`  [webhook]  ${payload.event.type} (${verified ? "✓ signed" : "✗ bad sig"})`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }).listen(port);
}
