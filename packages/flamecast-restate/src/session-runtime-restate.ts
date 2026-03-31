/**
 * Restate implementation of SessionRuntime.
 *
 * Maps SessionRuntime methods to Restate SDK primitives:
 *   step      → ctx.run(name, fn)
 *   awakeable → ctx.awakeable()
 *   state     → ctx.get/set/clear/clearAll
 *   emit      → pubsub publisher (journaled)
 *   now       → ctx.date.now()
 */

import type * as restate from "@restatedev/restate-sdk";
import { createPubsubPublisher } from "@restatedev/pubsub";
import type { SessionRuntime } from "./session-runtime.js";

const publish = createPubsubPublisher("pubsub");

export function createRestateSessionRuntime(
  ctx: restate.ObjectContext,
): SessionRuntime {
  return {
    key: ctx.key,

    step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return ctx.run(name, fn);
    },

    awakeable<T = unknown>(): { id: string; promise: Promise<T> } {
      return ctx.awakeable<T>();
    },

    state: {
      get<T>(key: string): Promise<T | null> {
        return ctx.get<T>(key);
      },
      set(key: string, value: unknown): void {
        ctx.set(key, value);
      },
      clear(key: string): void {
        ctx.clear(key);
      },
      clearAll(): void {
        ctx.clearAll();
      },
    },

    emit(topic: string, event: unknown): void {
      publish(ctx, topic, event);
    },

    sendService(service: string, handler: string, payload: unknown): void {
      const client = ctx.serviceSendClient<Record<string, (p: unknown) => void>>(
        { name: service },
      );
      (client as unknown as Record<string, (p: unknown) => void>)[handler](payload);
    },

    async now(): Promise<string> {
      return new Date(await ctx.date.now()).toISOString();
    },
  };
}
