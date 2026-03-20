import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ConversationSource } from "@/shared/integrations.js";
import { getIntegrationConfig } from "./config.js";
import { linearGraphql } from "./linear-client.js";
import type { ConversationRuntime } from "./runtime.js";

const AgentSessionPayloadSchema = z.object({
  action: z.enum(["created", "prompted"]),
  agentActivity: z
    .object({
      body: z.string().optional(),
      id: z.string().optional(),
    })
    .passthrough()
    .optional(),
  agentSession: z
    .object({
      id: z.string(),
      issue: z
        .object({
          id: z.string().optional(),
          identifier: z.string().optional(),
        })
        .passthrough()
        .optional(),
      promptContext: z.string().optional(),
    })
    .passthrough()
    .optional(),
  organizationId: z.string().optional(),
  promptContext: z.string().optional(),
  type: z.string().optional(),
  webhookTimestamp: z.number().optional(),
});

const AgentActivityMutationSchema = z.object({
  data: z.object({
    agentActivityCreate: z.object({
      success: z.boolean(),
    }),
  }),
});

const AgentSessionUpdateSchema = z.object({
  data: z.object({
    agentSessionUpdate: z.object({
      success: z.boolean(),
    }),
  }),
});

function verifySignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) {
    return false;
  }
  const computed = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

function buildSessionSource(payload: z.infer<typeof AgentSessionPayloadSchema>): ConversationSource {
  const sessionId = payload.agentSession?.id;
  if (!sessionId) {
    throw new Error("Linear agent payload is missing agentSession.id");
  }
  const issueIdentifier = payload.agentSession?.issue?.identifier ?? payload.agentSession?.issue?.id ?? null;
  return {
    platform: "linear_agent_session",
    threadId: sessionId,
    installId: null,
    externalWorkspaceId: payload.organizationId ?? null,
    externalThreadLabel: issueIdentifier,
  };
}

function buildIncomingMessage(payload: z.infer<typeof AgentSessionPayloadSchema>): string {
  if (payload.action === "prompted") {
    return payload.agentActivity?.body?.trim() || payload.promptContext?.trim() || "Follow up from Linear";
  }
  return payload.promptContext?.trim() || "New Linear agent session";
}

async function emitActivity(
  agentSessionId: string,
  content: Record<string, unknown>,
  ephemeral = false,
): Promise<void> {
  const query = `
    mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
      }
    }
  `;
  await linearGraphql(
    query,
    {
      input: {
        agentSessionId,
        content,
        ephemeral,
      },
    },
    (input) => AgentActivityMutationSchema.parse(input),
  );
}

async function updateSessionExternalUrl(
  agentSessionId: string,
  url: string,
  label = "Open Flamecast",
): Promise<void> {
  const query = `
    mutation AgentSessionUpdate($agentSessionId: String!, $data: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $agentSessionId, input: $data) {
        success
      }
    }
  `;
  await linearGraphql(
    query,
    {
      agentSessionId,
      data: {
        externalUrls: [{ label, url }],
      },
    },
    (input) => AgentSessionUpdateSchema.parse(input),
  );
}

function extractActionActivities(logs: Array<{ type: string; data: Record<string, unknown> }>): Array<{
  action: string;
  parameter: string;
  result?: string;
}> {
  return logs.flatMap((entry) => {
    if (entry.type !== "session_update" || entry.data.sessionUpdate !== "tool_call") {
      return [];
    }
    const title = typeof entry.data.title === "string" ? entry.data.title : "Tool call";
    const kind = typeof entry.data.kind === "string" ? entry.data.kind : "tool";
    return [
      {
        action: title,
        parameter: kind,
      },
    ];
  });
}

export function createLinearAgentRoutes(runtime: ConversationRuntime): Hono {
  const routes = new Hono();

  routes.post("/webhooks/linear/agent-sessions", async (c) => {
    const config = getIntegrationConfig();
    if (!config.linear.enabled || !config.linear.webhookSecret) {
      return c.json({ error: "Linear agent session integration is not configured" }, 503);
    }

    const body = await c.req.raw.text();
    const signature = c.req.header("linear-signature") ?? null;
    if (!verifySignature(body, signature, config.linear.webhookSecret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let parsedPayload: z.infer<typeof AgentSessionPayloadSchema>;
    try {
      parsedPayload = AgentSessionPayloadSchema.parse(JSON.parse(body));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid agent session payload" },
        400,
      );
    }

    if (
      typeof parsedPayload.webhookTimestamp === "number" &&
      Math.abs(Date.now() - parsedPayload.webhookTimestamp) > 5 * 60 * 1000
    ) {
      return c.json({ error: "Webhook expired" }, 401);
    }

    void (async () => {
      const source = buildSessionSource(parsedPayload);
      const sessionId = source.threadId;
      try {
        if (parsedPayload.action === "created") {
          await emitActivity(
            sessionId,
            {
              type: "thought",
              body: "Flamecast is starting the task.",
            },
            true,
          );
        }

        const result = await runtime.runPrompt(source, buildIncomingMessage(parsedPayload));
        const appOrigin = process.env.FLAMECAST_APP_ORIGIN?.trim();
        if (appOrigin && result.binding.connectionId) {
          await updateSessionExternalUrl(
            sessionId,
            `${appOrigin.replace(/\/$/, "")}/connections/${result.binding.connectionId}`,
          );
        }

        const actions = extractActionActivities(result.captured.logs);
        for (const action of actions) {
          await emitActivity(sessionId, {
            action: action.action,
            parameter: action.parameter,
            result: action.result,
            type: "action",
          });
        }

        await emitActivity(sessionId, {
          body:
            result.captured.assistantText.trim() ||
            `Completed with stop reason: ${result.captured.result.stopReason}`,
          type: "response",
        });
      } catch (error) {
        await emitActivity(sessionId, {
          body: error instanceof Error ? error.message : "Unknown failure",
          type: "error",
        });
      }
    })();

    return c.json({ ok: true });
  });

  return routes;
}
