import { createLinearAdapter } from "@chat-adapter/linear";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat, type Message, type Thread } from "chat";
import { Hono } from "hono";
import type { Pool } from "pg";
import type { ConversationSource } from "@/shared/integrations.js";
import { getIntegrationConfig } from "./config.js";
import type { ConversationRuntime } from "./runtime.js";
import { IntegrationStore } from "./store.js";
import { makeBearerInstallSecret } from "./broker.js";

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function buildSourceFromMessage(
  thread: Thread,
  message: Message,
  slackInstallId: string | null,
): ConversationSource {
  if (thread.id.startsWith("slack:")) {
    const raw = toRecord(message.raw);
    const workspaceId = getString(raw.team_id) ?? getString(raw.team);
    return {
      platform: "slack",
      threadId: thread.id,
      installId: slackInstallId,
      externalWorkspaceId: workspaceId,
      externalThreadLabel: thread.id,
    };
  }

  const raw = toRecord(message.raw);
  return {
    platform: "linear_comment",
    threadId: thread.id,
    installId: null,
    externalWorkspaceId: getString(raw.organizationId),
    externalThreadLabel: thread.id,
  };
}

async function replyFromPrompt(
  runtime: ConversationRuntime,
  thread: Thread,
  source: ConversationSource,
  text: string,
): Promise<void> {
  const result = await runtime.runPrompt(source, text);
  const reply =
    result.captured.assistantText.trim() ||
    `Completed with stop reason: ${result.captured.result.stopReason}`;
  await thread.post(reply);
}

export interface PlatformBridge {
  routes: Hono;
}

export function createPlatformBridge(options: {
  pool: Pool | null;
  runtime: ConversationRuntime;
  store: IntegrationStore;
}): PlatformBridge {
  const config = getIntegrationConfig();
  const routes = new Hono();

  if (!options.pool || !config.enabled) {
    routes.all("/*", (c) => c.json({ error: "Integration platform bridge is disabled" }, 503));
    return { routes };
  }

  const adapters: Record<string, ReturnType<typeof createSlackAdapter> | ReturnType<typeof createLinearAdapter>> = {};
  let slackAdapter: SlackAdapter | null = null;

  if (config.slack.enabled) {
    slackAdapter = createSlackAdapter({
      clientId: config.slack.clientId ?? undefined,
      clientSecret: config.slack.clientSecret ?? undefined,
      encryptionKey: config.slack.encryptionKey ?? undefined,
      signingSecret: config.slack.signingSecret ?? undefined,
      userName: config.botName,
    });
    adapters.slack = slackAdapter;
  }

  if (config.linear.enabled) {
    if (config.linear.accessToken) {
      adapters.linear = createLinearAdapter({
        accessToken: config.linear.accessToken,
        userName: config.botName,
        webhookSecret: config.linear.webhookSecret ?? undefined,
      });
    } else if (config.linear.clientId && config.linear.clientSecret) {
      adapters.linear = createLinearAdapter({
        clientId: config.linear.clientId,
        clientSecret: config.linear.clientSecret,
        userName: config.botName,
        webhookSecret: config.linear.webhookSecret ?? undefined,
      });
    } else {
      adapters.linear = createLinearAdapter({
        userName: config.botName,
        webhookSecret: config.linear.webhookSecret ?? undefined,
      });
    }
  }

  const chat = new Chat({
    adapters,
    logger: "info",
    state: createPostgresState({ client: options.pool }),
    userName: config.botName,
  });

  async function handleIncomingMessage(thread: Thread, message: Message): Promise<void> {
    let slackInstallId: string | null = null;
    if (thread.id.startsWith("slack:")) {
      const raw = toRecord(message.raw);
      const teamId = getString(raw.team_id) ?? getString(raw.team);
      if (teamId) {
        const install = await options.store.getInstallByProviderExternalId("slack", teamId);
        slackInstallId = install?.id ?? null;
      }
    }
    const source = buildSourceFromMessage(thread, message, slackInstallId);
    await replyFromPrompt(options.runtime, thread, source, message.text);
  }

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await handleIncomingMessage(thread, message);
  });

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe();
    await handleIncomingMessage(thread, message);
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await handleIncomingMessage(thread, message);
  });

  if (slackAdapter) {
    routes.post("/webhooks/slack", async (c) => chat.webhooks.slack(c.req.raw));
    routes.get("/oauth/slack/callback", async (c) => {
      await chat.initialize();
      const result = await slackAdapter.handleOAuthCallback(c.req.raw);
      const install = await slackAdapter.getInstallation(result.teamId);
      if (install?.botToken) {
        await options.store.upsertInstall({
          credential: makeBearerInstallSecret(install.botToken),
          externalId: result.teamId,
          label: install.teamName ?? `Slack ${result.teamId}`,
          metadata: {
            botUserId: install.botUserId ?? null,
            teamName: install.teamName ?? null,
          },
          provider: "slack",
        });
      }
      return c.json({ ok: true, teamId: result.teamId });
    });
  }

  if ("linear" in adapters) {
    routes.post("/webhooks/linear/comments", async (c) => chat.webhooks.linear(c.req.raw));
  }

  return { routes };
}
