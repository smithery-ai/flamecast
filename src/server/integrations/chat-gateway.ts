import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Chat,
  deriveChannelId,
  ThreadImpl,
  type Message,
  type StateAdapter,
  type Thread,
} from "chat";
import { asc, eq } from "drizzle-orm";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { z } from "zod";
import type { Flamecast } from "@/flamecast/index.js";
import {
  slackConnectionBindings,
  slackWorkspaceInstalls,
} from "@/flamecast/state-managers/psql/schema.js";
import type {
  ChatActionRequest,
  ChatActionResult,
  ChatDispatchContext,
  ChatInboundEvent,
} from "@/shared/chat.js";
import {
  type SlackConnectionStatus,
  type SlackInstallationSummary,
  SlackConnectionStatusSchema,
  SlackInstallationSummarySchema,
} from "@/shared/integrations.js";
import type { AppDb } from "../db/client.js";

const SLACK_SCOPES = ["app_mentions:read", "chat:write", "im:history", "users:read"] as const;

const InstallStateSchema = z.object({
  issuedAt: z.number().int().nonnegative(),
  returnTo: z.string().min(1).optional(),
});

type InstallState = z.infer<typeof InstallStateSchema>;
type SlackBinding = typeof slackConnectionBindings.$inferSelect;
type SlackInstallationRecord = typeof slackWorkspaceInstalls.$inferSelect;
type ChatQueryDb = Pick<AppDb, "delete" | "insert" | "select" | "update">;

interface SlackConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: URL;
  signingSecret: string;
  stateSecret: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getSlackConfig(): SlackConfig {
  return {
    clientId: requiredEnv("SLACK_CLIENT_ID"),
    clientSecret: requiredEnv("SLACK_CLIENT_SECRET"),
    publicUrl: new URL(requiredEnv("FLAMECAST_PUBLIC_URL")),
    signingSecret: requiredEnv("SLACK_SIGNING_SECRET"),
    stateSecret: requiredEnv("SLACK_STATE_SECRET"),
  };
}

function encodeInstallState(payload: InstallState, secret: string): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeInstallState(token: string | null, secret: string): InstallState {
  if (!token) {
    throw new Error("Missing OAuth state");
  }

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    throw new Error("Invalid OAuth state");
  }

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid OAuth state signature");
  }

  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  return InstallStateSchema.parse(parsed);
}

function resolveReturnTo(request: Request): string | undefined {
  const requestUrl = new URL(request.url);
  const returnTo = requestUrl.searchParams.get("returnTo");
  if (returnTo) {
    return normalizeReturnTo(returnTo, request.headers.get("referer") ?? requestUrl.origin);
  }

  const referer = request.headers.get("referer");
  if (!referer) {
    return undefined;
  }

  return normalizeReturnTo(referer, requestUrl.origin);
}

function callbackUrl(publicUrl: URL): string {
  return new URL("/api/integrations/slack/oauth/callback", publicUrl).toString();
}

function fallbackReturnTo(publicUrl: URL): string {
  return new URL("/", publicUrl).toString();
}

function normalizeReturnTo(value: string, base: string): string | undefined {
  try {
    return new URL(value).toString();
  } catch {
    try {
      return new URL(value, base).toString();
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

function getSlackTeamId(raw: unknown): string | null {
  return getStringField(raw, "team_id") ?? getStringField(raw, "team");
}

function getSlackThreadTimestamp(raw: unknown): string | null {
  return getStringField(raw, "thread_ts") ?? getStringField(raw, "ts");
}

function getSlackChannel(raw: unknown): string | null {
  return getStringField(raw, "channel");
}

function statusFromBinding(input: {
  binding: SlackBinding;
  botUserId?: string;
  teamName?: string;
}): SlackConnectionStatus {
  return SlackConnectionStatusSchema.parse({
    bound: true,
    teamId: input.binding.teamId,
    teamName: input.teamName ?? null,
    botUserId: input.botUserId ?? null,
    boundAt: input.binding.boundAt,
    updatedAt: input.binding.updatedAt,
  });
}

function unboundStatus(): SlackConnectionStatus {
  return SlackConnectionStatusSchema.parse({
    bound: false,
    teamId: null,
    teamName: null,
    botUserId: null,
    boundAt: null,
    updatedAt: null,
  });
}

function summaryFromInstallation(input: {
  botUserId?: string;
  installedAt: string;
  teamId: string;
  teamName?: string;
  updatedAt: string;
}): SlackInstallationSummary {
  return SlackInstallationSummarySchema.parse({
    botUserId: input.botUserId ?? null,
    installedAt: input.installedAt,
    teamId: input.teamId,
    teamName: input.teamName ?? null,
    updatedAt: input.updatedAt,
  });
}

export class ChatGateway {
  private readonly bot: Chat<{ slack: SlackAdapter }>;
  private readonly config = getSlackConfig();
  private readonly slack: SlackAdapter;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly flamecast: Flamecast,
    private readonly db: AppDb,
    state: StateAdapter,
  ) {
    this.slack = createSlackAdapter({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      encryptionKey: process.env.SLACK_ENCRYPTION_KEY?.trim() || undefined,
      signingSecret: this.config.signingSecret,
    });

    this.bot = new Chat({
      adapters: { slack: this.slack },
      state,
      userName: "flamecast",
    }).registerSingleton();

    this.bot.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await this.handleInboundSlackMessage(thread, message);
    });

    this.bot.onDirectMessage(async (thread, message) => {
      await thread.subscribe();
      await this.handleInboundSlackMessage(thread, message);
    });

    this.bot.onSubscribedMessage(async (thread, message) => {
      await this.handleInboundSlackMessage(thread, message);
    });
  }

  async startSlackInstall(request: Request): Promise<Response> {
    await this.ensureInitialized();

    const state = encodeInstallState(
      {
        issuedAt: Date.now(),
        returnTo: resolveReturnTo(request),
      },
      this.config.stateSecret,
    );

    const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizeUrl.searchParams.set("client_id", this.config.clientId);
    authorizeUrl.searchParams.set("scope", SLACK_SCOPES.join(","));
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl(this.config.publicUrl));
    authorizeUrl.searchParams.set("state", state);

    return Response.redirect(authorizeUrl.toString(), 302);
  }

  async handleSlackCallback(request: Request): Promise<Response> {
    await this.ensureInitialized();

    let state: InstallState;
    try {
      state = decodeInstallState(
        new URL(request.url).searchParams.get("state"),
        this.config.stateSecret,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Slack install state";
      return new Response(message, { status: 400 });
    }

    try {
      const { teamId } = await this.slack.handleOAuthCallback(request);
      await this.upsertInstallationRecord(teamId);

      return Response.redirect(state.returnTo ?? fallbackReturnTo(this.config.publicUrl), 302);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack install failed";
      return new Response(message, { status: 400 });
    }
  }

  async handleSlackWebhook(request: Request): Promise<Response> {
    await this.ensureInitialized();
    return this.bot.webhooks.slack(request);
  }

  async listSlackInstallations(): Promise<SlackInstallationSummary[]> {
    await this.ensureInitialized();

    const records = await this.getInstallationRecords();
    return Promise.all(records.map((record) => this.getInstallationSummary(record)));
  }

  async bindSlackWorkspace(connectionId: string, teamId: string): Promise<SlackConnectionStatus> {
    await this.ensureInitialized();

    const installation = await this.slack.getInstallation(teamId);
    if (!installation) {
      throw new Error("Slack workspace is not installed");
    }

    await this.upsertInstallationRecord(teamId);
    await this.bindConnectionToTeam(connectionId, teamId);
    const binding = await this.getBindingByConnection(connectionId);
    if (!binding) {
      throw new Error("Slack workspace binding was not persisted");
    }

    return statusFromBinding({
      binding,
      botUserId: installation.botUserId,
      teamName: installation.teamName,
    });
  }

  async getSlackConnectionStatus(connectionId: string): Promise<SlackConnectionStatus> {
    await this.ensureInitialized();

    const binding = await this.getBindingByConnection(connectionId);
    if (!binding) {
      return unboundStatus();
    }

    const liveConnection = await this.flamecast.get(connectionId);
    if (liveConnection.sessionId !== binding.connectionSessionId) {
      return unboundStatus();
    }

    const installationRecord = await this.getInstallationRecord(binding.teamId);
    if (!installationRecord) {
      return unboundStatus();
    }

    const installation = await this.safeGetInstallation(binding.teamId);
    return statusFromBinding({
      binding,
      botUserId: installation?.botUserId,
      teamName: installation?.teamName,
    });
  }

  async disconnectSlackWorkspace(connectionId: string): Promise<void> {
    await this.ensureInitialized();
    await this.db
      .delete(slackConnectionBindings)
      .where(eq(slackConnectionBindings.connectionId, connectionId));
  }

  async executeAction(input: {
    action: ChatActionRequest;
    connectionId: string;
    sourceContext: ChatDispatchContext | null;
  }): Promise<ChatActionResult> {
    await this.ensureInitialized();

    const binding = await this.getBindingByConnection(input.connectionId);
    if (!binding) {
      throw new Error("No Slack workspace is bound to this connection");
    }

    const liveConnection = await this.flamecast.get(input.connectionId);
    if (liveConnection.sessionId !== binding.connectionSessionId) {
      throw new Error("The bound Slack workspace is no longer valid for this connection session");
    }

    const installation = await this.getInstallationRecord(binding.teamId);
    if (!installation) {
      throw new Error("The bound Slack workspace is no longer installed");
    }

    switch (input.action.type) {
      case "reply_source": {
        if (!input.sourceContext) {
          throw new Error("reply_source requires an active source context");
        }
        return this.postThreadMessage(
          input.sourceContext.threadId,
          input.sourceContext.isDM,
          input.action.text,
        );
      }
      case "post_thread":
        return this.postThreadMessage(
          input.action.threadId,
          this.slack.isDM?.(input.action.threadId) ?? false,
          input.action.text,
        );
      case "post_channel":
        return this.postChannelMessage(input.action.channelId, input.action.text);
      case "start_thread":
        return this.postChannelMessage(input.action.channelId, input.action.text);
      case "dm_user":
        return this.postDirectMessage(input.action.userId, input.action.text);
      case "react":
        await this.slack.addReaction(
          input.action.threadId,
          input.action.messageId,
          input.action.emoji,
        );
        return {
          channelId: deriveChannelId(this.slack, input.action.threadId),
          messageId: input.action.messageId,
          provider: "slack",
          threadId: input.action.threadId,
        };
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bot.initialize();
    }
    await this.initPromise;
  }

  private createInboundEvent(thread: Thread, message: Message): ChatInboundEvent {
    const teamId = getSlackTeamId(message.raw);
    const threadTimestamp = getSlackThreadTimestamp(message.raw);
    const channel = getSlackChannel(message.raw);

    return {
      authorId: message.author.userId,
      authorName: message.author.fullName || message.author.userName || message.author.userId,
      channelId: thread.channelId,
      isDM: thread.isDM,
      messageId: message.id,
      occurredAt: message.metadata.dateSent.toISOString(),
      provider: "slack",
      providerMeta: {
        ...(teamId ? { teamId } : {}),
        ...(threadTimestamp ? { threadTs: threadTimestamp } : {}),
        ...(channel ? { rawChannel: channel } : {}),
      },
      text: message.text.trim(),
      threadId: message.threadId,
    };
  }

  private async handleInboundSlackMessage(thread: Thread, message: Message): Promise<void> {
    if (message.author.isMe) {
      return;
    }

    const teamId = getSlackTeamId(message.raw);
    if (!teamId) {
      await thread.post("Slack team could not be resolved for this message.");
      return;
    }

    const binding = await this.getBindingByTeam(teamId);
    if (!binding) {
      await thread.post("This Slack workspace is not bound to a Flamecast connection.");
      return;
    }

    try {
      const liveConnection = await this.flamecast.get(binding.connectionId);
      if (liveConnection.sessionId !== binding.connectionSessionId) {
        await thread.post("The bound Flamecast connection is offline.");
        return;
      }
    } catch {
      await thread.post("The bound Flamecast connection is offline.");
      return;
    }

    await thread.startTyping("Thinking...").catch(() => undefined);

    try {
      await this.flamecast.enqueueChatEvent(
        binding.connectionId,
        this.createInboundEvent(thread, message),
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error while queueing the event";
      await thread.post(`Flamecast failed to handle this Slack message: ${errorMessage}`);
    }
  }

  private async postChannelMessage(channelId: string, text: string): Promise<ChatActionResult> {
    const sent = await this.bot.channel(channelId).post(text);
    return {
      channelId,
      messageId: sent.id,
      provider: "slack",
      threadId: sent.threadId,
    };
  }

  private async postDirectMessage(userId: string, text: string): Promise<ChatActionResult> {
    const thread = await this.bot.openDM(userId);
    const sent = await thread.post(text);
    return {
      channelId: thread.channelId,
      messageId: sent.id,
      provider: "slack",
      threadId: thread.id,
    };
  }

  private async postThreadMessage(
    threadId: string,
    isDM: boolean,
    text: string,
  ): Promise<ChatActionResult> {
    const thread = ThreadImpl.fromJSON(
      {
        _type: "chat:Thread",
        adapterName: "slack",
        channelId: deriveChannelId(this.slack, threadId),
        id: threadId,
        isDM,
      },
      this.slack,
    );
    const sent = await thread.post(text);
    return {
      channelId: thread.channelId,
      messageId: sent.id,
      provider: "slack",
      threadId: thread.id,
    };
  }

  private async bindConnectionToTeam(connectionId: string, teamId: string): Promise<void> {
    const connection = await this.flamecast.get(connectionId);
    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      const existingTeamBinding = await this.getBindingByTeam(teamId, tx);
      const existingConnectionBinding = await this.getBindingByConnection(connectionId, tx);
      const boundAt = existingTeamBinding?.boundAt ?? existingConnectionBinding?.boundAt ?? now;

      await tx
        .delete(slackConnectionBindings)
        .where(eq(slackConnectionBindings.connectionId, connectionId));
      await tx.delete(slackConnectionBindings).where(eq(slackConnectionBindings.teamId, teamId));
      await tx.insert(slackConnectionBindings).values({
        boundAt,
        connectionId,
        connectionSessionId: connection.sessionId,
        teamId,
        updatedAt: now,
      });
    });
  }

  private async getBindingByConnection(
    connectionId: string,
    db: ChatQueryDb = this.db,
  ): Promise<SlackBinding | null> {
    const rows = await db
      .select()
      .from(slackConnectionBindings)
      .where(eq(slackConnectionBindings.connectionId, connectionId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getBindingByTeam(
    teamId: string,
    db: ChatQueryDb = this.db,
  ): Promise<SlackBinding | null> {
    const rows = await db
      .select()
      .from(slackConnectionBindings)
      .where(eq(slackConnectionBindings.teamId, teamId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getInstallationRecords(): Promise<SlackInstallationRecord[]> {
    return this.db
      .select()
      .from(slackWorkspaceInstalls)
      .orderBy(asc(slackWorkspaceInstalls.teamId));
  }

  private async getInstallationRecord(teamId: string): Promise<SlackInstallationRecord | null> {
    const rows = await this.db
      .select()
      .from(slackWorkspaceInstalls)
      .where(eq(slackWorkspaceInstalls.teamId, teamId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getInstallationSummary(
    record: SlackInstallationRecord,
  ): Promise<SlackInstallationSummary> {
    const installation = await this.safeGetInstallation(record.teamId);
    return summaryFromInstallation({
      botUserId: installation?.botUserId,
      installedAt: record.installedAt,
      teamId: record.teamId,
      teamName: installation?.teamName,
      updatedAt: record.updatedAt,
    });
  }

  private async safeGetInstallation(teamId: string) {
    try {
      return await this.slack.getInstallation(teamId);
    } catch {
      return null;
    }
  }

  private async upsertInstallationRecord(teamId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(slackWorkspaceInstalls)
      .values({
        installedAt: now,
        teamId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: slackWorkspaceInstalls.teamId,
        set: { updatedAt: now },
      });
  }
}
