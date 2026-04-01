/**
 * ZedAgentSession — Restate Virtual Object for Zed ACP agents.
 *
 * Single blocking promptSync pattern: `ctx.run("prompt")` blocks until the
 * agent responds. This is different from IbmAgentSession which uses
 * create + awakeable (zero compute while waiting).
 *
 * Token streaming for Zed is via session-host WebSocket (client-direct),
 * NOT through the VO.
 *
 * Needs increased Restate inactivity timeout — set at service config level
 * (restate.toml or deployment registration), not in code.
 *
 * Reference: docs/sdd-durable-acp-bridge.md §5.2
 */

import * as restate from "@restatedev/restate-sdk";
import type {
  SessionHandle,
  PromptResult,
  AgentStartConfig,
  SessionMeta,
} from "./adapter.js";
import { ZedAcpAdapter } from "./zed-acp-adapter.js";
import { sharedHandlers, publish, handleResult } from "./shared-handlers.js";

export const ZedAgentSession = restate.object({
  name: "ZedAgentSession",
  handlers: {
    ...sharedHandlers,

    /**
     * Start a new Zed ACP session.
     * Spawns the agent process, sends initialize + session/new.
     * Stores SessionHandle in VO state.
     */
    startSession: async (
      ctx: restate.ObjectContext,
      input: AgentStartConfig,
    ): Promise<SessionHandle> => {
      const adapter = new ZedAcpAdapter();
      const session = await ctx.run("start", () => adapter.start(input));

      const now = new Date().toISOString();
      const meta: SessionMeta = {
        sessionId: ctx.key,
        protocol: "zed",
        agent: session.agent,
        status: "active",
        startedAt: now,
        lastUpdatedAt: now,
      };
      ctx.set("session", session);
      ctx.set("meta", meta);

      publish(ctx, `session:${ctx.key}`, { type: "session.created", meta });
      return session;
    },

    /**
     * Run the agent — single blocking promptSync pattern.
     * ctx.run("prompt") blocks until the agent responds.
     * Needs increased inactivity timeout for long-running agents.
     */
    runAgent: async (
      ctx: restate.ObjectContext,
      input: { text: string },
    ): Promise<PromptResult> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      // Single ctx.run — blocks until agent responds.
      const result = await ctx.run("prompt", () =>
        adapter.promptSync(session, input.text),
      );

      return handleResult(ctx, adapter, session, result);
    },

    /**
     * Cancel the current agent run.
     */
    cancelAgent: async (
      ctx: restate.ObjectContext,
    ): Promise<{ cancelled: boolean }> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      await ctx.run("cancel", () => new ZedAcpAdapter().cancel(session));
      ctx.clear("pending_pause");
      return { cancelled: true };
    },

    /**
     * Steer the agent — cancel, optionally reconfigure, then re-prompt.
     * Each step is a separate ctx.run() for journaling.
     */
    steerAgent: async (
      ctx: restate.ObjectContext,
      input: { newText: string; mode?: string; model?: string },
    ): Promise<PromptResult> => {
      const session = await ctx.get<SessionHandle>("session");
      if (!session) throw new restate.TerminalError("No active session");
      const adapter = new ZedAcpAdapter();

      await ctx.run("cancel", () => adapter.cancel(session));
      if (input.mode) {
        await ctx.run("set-mode", () =>
          adapter.setConfigOption(session, "mode", input.mode!),
        );
      }
      if (input.model) {
        await ctx.run("set-model", () =>
          adapter.setConfigOption(session, "model", input.model!),
        );
      }

      // Re-prompt with the new text (blocking pattern)
      const result = await ctx.run("re-prompt", () =>
        adapter.promptSync(session, input.newText),
      );

      return handleResult(ctx, adapter, session, result);
    },

    /**
     * Terminate the session. Kill process, cleanup state after delay.
     */
    terminateSession: async (ctx: restate.ObjectContext): Promise<void> => {
      const session = await ctx.get<SessionHandle>("session");
      if (session) {
        await ctx.run("close", () => new ZedAcpAdapter().close(session));
      }

      // Update meta to killed status
      const meta = await ctx.get<SessionMeta>("meta");
      if (meta) {
        ctx.set("meta", {
          ...meta,
          status: "killed" as const,
          lastUpdatedAt: new Date().toISOString(),
        });
      }

      publish(ctx, `session:${ctx.key}`, { type: "session.terminated" });

      // Schedule state cleanup after 7 days
      ctx
        .objectSendClient(ZedAgentSession, ctx.key, {
          delay: 7 * 24 * 60 * 60 * 1000,
        })
        .cleanup();
    },
  },
});
