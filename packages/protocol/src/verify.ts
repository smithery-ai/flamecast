import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an incoming webhook signature.
 *
 * Usage:
 *   const body = await req.text();
 *   const sig = req.headers.get("X-Flamecast-Signature")!;
 *   if (!verifyWebhookSignature(secret, body, sig)) return new Response("unauthorized", { status: 401 });
 */
export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Sign a webhook payload body. Returns the full signature string including the "sha256=" prefix. */
export function signWebhookPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}
