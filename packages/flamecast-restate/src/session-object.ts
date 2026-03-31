/**
 * FlamecastSession Virtual Object — thin Restate wrapper around session lifecycle.
 *
 * Handlers delegate to session-lifecycle.ts via SessionRuntime.
 * No business logic here — just create the runtime and call through.
 */

import * as restate from "@restatedev/restate-sdk";
import { createPubsubObject } from "@restatedev/pubsub";
import type { WebhookConfig } from "@flamecast/protocol/session";
import { createRestateSessionRuntime } from "./session-runtime-restate.js";
import * as lifecycle from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// Types (re-exported for consumers)
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  agentName: string;
  hostUrl: string;
  websocketUrl: string;
  runtimeName: string;
  status: "active" | "killed";
  startedAt: string;
  lastUpdatedAt: string;
  spawn: { command: string; args: string[] };
  pendingPermission: unknown | null;
}

export interface StartSessionInput {
  runtimeUrl: string;
  spawn: { command: string; args: string[] };
  cwd: string;
  setup?: string;
  env?: Record<string, string>;
  callbackUrl?: string;
  agentName: string;
  runtimeName: string;
  webhooks?: WebhookConfig[];
}

export interface SessionCallbackEvent {
  type: string;
  data: unknown;
}

export interface SessionState {
  meta: SessionMeta;
  webhooks: WebhookConfig[];
  currentTurn: { id: string; text: string; status: string } | null;
  pending_permission: { awakeableId: string; data: unknown } | null;
  waiting_for: { awakeableId: string; filter: Record<string, unknown> } | null;
}

// Phase 5 — not yet wired
export interface WaitForInput {
  filter: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ScheduleInput {
  prompt: string;
  delayMs: number;
}

// ---------------------------------------------------------------------------
// Pubsub object — registered on the Restate endpoint alongside FlamecastSession
// ---------------------------------------------------------------------------

export const pubsubObject = createPubsubObject("pubsub", {});

// ---------------------------------------------------------------------------
// Virtual Object
// ---------------------------------------------------------------------------

export const FlamecastSession = restate.object({
  name: "FlamecastSession",
  handlers: {
    start: async (ctx: restate.ObjectContext, input: StartSessionInput) => {
      const rt = createRestateSessionRuntime(ctx);
      return lifecycle.startSession(rt, input);
    },

    terminate: async (ctx: restate.ObjectContext) => {
      const rt = createRestateSessionRuntime(ctx);
      await lifecycle.terminateSession(rt);
      // Schedule state cleanup after 7 days
      ctx.objectSendClient(FlamecastSession, ctx.key, { delay: 7 * 24 * 60 * 60 * 1000 }).cleanup();
    },

    handleCallback: async (ctx: restate.ObjectContext, event: SessionCallbackEvent) => {
      const rt = createRestateSessionRuntime(ctx);
      const result = await lifecycle.handleCallback(rt, event);
      // Schedule cleanup on session end
      if (event.type === "session_end") {
        ctx.objectSendClient(FlamecastSession, ctx.key, { delay: 7 * 24 * 60 * 60 * 1000 }).cleanup();
      }
      return result;
    },

    // Shared handlers — concurrent, non-blocking, lazy state

    sendEvent: restate.handlers.object.shared(
      { enableLazyState: true },
      async (ctx: restate.ObjectSharedContext, event: { awakeableId: string; payload: unknown }) => {
        ctx.resolveAwakeable(event.awakeableId, event.payload);
      },
    ),

    getStatus: restate.handlers.object.shared(
      { enableLazyState: true },
      async (ctx: restate.ObjectSharedContext) => ctx.get<SessionMeta>("meta"),
    ),

    getWebhooks: restate.handlers.object.shared(
      { enableLazyState: true },
      async (ctx: restate.ObjectSharedContext) => (await ctx.get<WebhookConfig[]>("webhooks")) ?? [],
    ),

    cleanup: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.clearAll();
    },

    // -----------------------------------------------------------------
    // Phase 5 — temporal primitives. Not yet wired to any code path.
    // -----------------------------------------------------------------

    waitFor: async (ctx: restate.ObjectContext, input: WaitForInput) => {
      // Uses ctx directly — RestatePromise.any requires Restate-native promises
      const { id, promise } = ctx.awakeable<unknown>();
      ctx.set("waiting_for", { awakeableId: id, filter: input.filter });

      let result: unknown;
      if (input.timeoutMs) {
        const timeout = ctx.sleep({ milliseconds: input.timeoutMs }).map(() => ({ __timeout: true as const }));
        const raceResult = await restate.RestatePromise.any([promise, timeout]);
        if (raceResult && typeof raceResult === "object" && "__timeout" in raceResult) {
          ctx.clear("waiting_for");
          throw new restate.TerminalError("Wait timed out");
        }
        result = raceResult;
      } else {
        result = await promise;
      }
      ctx.clear("waiting_for");
      return result;
    },

    schedule: async (ctx: restate.ObjectContext, input: ScheduleInput) => {
      ctx.objectSendClient(FlamecastSession, ctx.key).scheduledTurn(
        { prompt: input.prompt },
        restate.rpc.sendOpts({ delay: { milliseconds: input.delayMs } }),
      );
      return { scheduled: true };
    },

    scheduledTurn: async (ctx: restate.ObjectContext, input: { prompt: string }) => {
      const meta = await ctx.get<SessionMeta>("meta");
      if (!meta || meta.status !== "active") return;
      await ctx.run("scheduled-prompt", async () => {
        await fetch(`${meta.hostUrl}/sessions/${ctx.key}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: input.prompt }),
        });
      });
    },
  },
});

export type FlamecastSessionApi = typeof FlamecastSession;
