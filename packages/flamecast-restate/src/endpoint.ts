import * as restate from "@restatedev/restate-sdk";
import { FlamecastSession, pubsubObject } from "./session-object.js";
import { WebhookDeliveryService } from "./webhook-service.js";

/**
 * Create a Restate endpoint with all Flamecast services registered.
 *
 * Usage:
 *   // As a standalone HTTP server (local dev):
 *   createRestateEndpoint().listen(9080);
 *
 *   // As a handler mounted on an existing HTTP server:
 *   const handler = createRestateEndpoint().handler();
 */
export function createRestateEndpoint() {
  return restate
    .endpoint()
    .bind(FlamecastSession)
    .bind(WebhookDeliveryService)
    .bind(pubsubObject);
}
