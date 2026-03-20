import { createHmac, timingSafeEqual } from "node:crypto";
import { Chat, type Message, type Thread } from "chat";
import {
  createSlackAdapter,
  type SlackAdapter,
  type SlackEvent,
} from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import { Hono } from "hono";
import { z } from "zod";
import type { Flamecast } from "@/flamecast/index.js";
import {
  type SlackConnectionStatus,
  type SlackInstallationSummary,
  SlackConnectionStatusSchema,
  SlackInstallationSummarySchema,
} from "@/shared/integrations.js";
import { createPGliteState } from "./pglite-state.js";
import type { ProviderInstaller } from "./types.js";

const SLACK_SCOPES = ["app_mentions:read", "chat:write", "im:history", "users:read"] as const;

const InstallStateSchema = z.object({
  issuedAt: z.number().int().nonnegative(),
  returnTo: z.string().min(1).optional(),
});

type InstallState = z.infer<typeof InstallStateSchema>;

const SlackBindingSchema = z.object({
  connectionId: z.string().min(1),
  connectionSessionId: z.string().min(1),
  boundAt: z.string().optional(),
  installedAt: z.string().optional(),
  teamId: z.string().min(1),
  updatedAt: z.string(),
}).transform((value) => ({
  boundAt: value.boundAt ?? value.installedAt ?? value.updatedAt,
  connectionId: value.connectionId,
  connectionSessionId: value.connectionSessionId,
  teamId: value.teamId,
  updatedAt: value.updatedAt,
}));

type SlackBinding = z.infer<typeof SlackBindingSchema>;

const SlackInstallationRecordSchema = z.object({
  teamId: z.string().min(1),
  installedAt: z.string(),
  updatedAt: z.string(),
});

type SlackInstallationRecord = z.infer<typeof SlackInstallationRecordSchema>;

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

function cleanPromptText(text: string): string {
  return text.trim();
}

function buildPromptText(input: {
  message: Message;
  raw: SlackEvent;
  teamId: string;
  teamName: string | null;
  thread: Thread;
}): string {
  const { message, raw, teamId, teamName, thread } = input;
  const surface = thread.isDM ? "direct_message" : "channel_thread";
  const channel = raw.channel ?? "unknown";
  const threadTs = raw.thread_ts ?? raw.ts ?? "none";
  const text = cleanPromptText(message.text);

  return [
    "[Slack]",
    `workspace: ${teamName ?? teamId} (${teamId})`,
    `surface: ${surface}`,
    `thread_id: ${thread.id}`,
    `channel: ${channel}`,
    `thread_ts: ${threadTs}`,
    `user: ${message.author.fullName} (${message.author.userId})`,
    "",
    text,
  ].join("\n");
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

export class SlackInstaller
  implements ProviderInstaller<SlackConnectionStatus, SlackInstallationSummary>
{
  private readonly bot: Chat<{ slack: SlackAdapter }>;
  private readonly config = getSlackConfig();
  private readonly slack: SlackAdapter;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly flamecast: Flamecast,
    state: StateAdapter = createPGliteState(),
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
    });

    this.bot.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await this.handleInboundMessage(thread, message);
    });

    this.bot.onDirectMessage(async (thread, message) => {
      await thread.subscribe();
      await this.handleInboundMessage(thread, message);
    });

    this.bot.onSubscribedMessage(async (thread, message) => {
      await this.handleInboundMessage(thread, message);
    });
  }

  async startInstall(request: Request): Promise<Response> {
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

  async handleCallback(request: Request): Promise<Response> {
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

      return Response.redirect(
        state.returnTo ?? fallbackReturnTo(this.config.publicUrl),
        302,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack install failed";
      return new Response(message, { status: 400 });
    }
  }

  async handleWebhook(request: Request): Promise<Response> {
    return this.bot.webhooks.slack(request);
  }

  async listInstallations(): Promise<SlackInstallationSummary[]> {
    await this.ensureInitialized();

    const records = await this.getInstallationRecords();
    return Promise.all(records.map((record) => this.getInstallationSummary(record)));
  }

  async bindConnection(
    connectionId: string,
    teamId: string,
  ): Promise<SlackConnectionStatus> {
    await this.ensureInitialized();

    const installation = await this.slack.getInstallation(teamId);
    if (!installation) {
      throw new Error("Slack workspace is not installed");
    }

    await this.upsertInstallationRecord(teamId);
    await this.bindConnectionToTeam(connectionId, teamId);

    return statusFromBinding({
      binding: (await this.getBindingByConnection(connectionId))!,
      botUserId: installation.botUserId,
      teamName: installation.teamName,
    });
  }

  async getConnectionStatus(connectionId: string): Promise<SlackConnectionStatus> {
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

  async disconnect(connectionId: string): Promise<void> {
    await this.ensureInitialized();

    const binding = await this.getBindingByConnection(connectionId);
    if (!binding) {
      return;
    }

    await this.deleteBinding(binding);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bot.initialize();
    }
    await this.initPromise;
  }

  private async bindConnectionToTeam(connectionId: string, teamId: string): Promise<void> {
    const connection = await this.flamecast.get(connectionId);
    const now = new Date().toISOString();
    const existingBinding = await this.getBindingByTeam(teamId);
    const existingConnectionBinding = await this.getBindingByConnection(connectionId);

    if (existingConnectionBinding && existingConnectionBinding.teamId !== teamId) {
      await this.deleteBinding(existingConnectionBinding);
    }

    if (existingBinding && existingBinding.connectionId !== connectionId) {
      await this.deleteBinding(existingBinding);
    }

    const binding: SlackBinding = {
      connectionId,
      connectionSessionId: connection.sessionId,
      boundAt: existingBinding?.boundAt ?? now,
      teamId,
      updatedAt: now,
    };

    await this.bot.getState().set(this.teamBindingKey(teamId), binding);
    await this.bot.getState().set(this.connectionBindingKey(connectionId), binding);
  }

  private async getBindingByConnection(connectionId: string): Promise<SlackBinding | null> {
    const binding = await this.bot.getState().get(this.connectionBindingKey(connectionId));
    return binding ? SlackBindingSchema.parse(binding) : null;
  }

  private async getBindingByTeam(teamId: string): Promise<SlackBinding | null> {
    const binding = await this.bot.getState().get(this.teamBindingKey(teamId));
    return binding ? SlackBindingSchema.parse(binding) : null;
  }

  private async deleteBinding(binding: SlackBinding): Promise<void> {
    await this.bot.getState().delete(this.teamBindingKey(binding.teamId));
    await this.bot.getState().delete(this.connectionBindingKey(binding.connectionId));
  }

  private teamBindingKey(teamId: string): string {
    return `slack:binding:team:${teamId}`;
  }

  private connectionBindingKey(connectionId: string): string {
    return `slack:binding:connection:${connectionId}`;
  }

  private installationKey(teamId: string): string {
    return `slack:installation:${teamId}`;
  }

  private installationIndexKey(): string {
    return "slack:installations:index";
  }

  private async getInstallationRecords(): Promise<SlackInstallationRecord[]> {
    const teamIds = await this.bot.getState().get<string[]>(this.installationIndexKey());
    if (!Array.isArray(teamIds) || teamIds.length === 0) {
      return [];
    }

    const records = await Promise.all(
      teamIds.map((teamId) => this.bot.getState().get(this.installationKey(teamId))),
    );

    return records
      .filter((record): record is unknown => record !== null)
      .map((record) => SlackInstallationRecordSchema.parse(record))
      .sort((a, b) => a.teamId.localeCompare(b.teamId));
  }

  private async getInstallationRecord(teamId: string): Promise<SlackInstallationRecord | null> {
    const record = await this.bot.getState().get(this.installationKey(teamId));
    return record ? SlackInstallationRecordSchema.parse(record) : null;
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
    const existing = await this.bot.getState().get(this.installationKey(teamId));
    const record = SlackInstallationRecordSchema.parse({
      installedAt:
        existing && typeof existing === "object" && "installedAt" in existing
          ? (existing as { installedAt?: string }).installedAt ?? now
          : now,
      teamId,
      updatedAt: now,
    });

    const existingIndex = await this.bot.getState().get<string[]>(this.installationIndexKey());
    const index = Array.isArray(existingIndex) ? existingIndex : [];
    if (!index.includes(teamId)) {
      index.push(teamId);
      index.sort((a, b) => a.localeCompare(b));
      await this.bot.getState().set(this.installationIndexKey(), index);
    }

    await this.bot.getState().set(this.installationKey(teamId), record);
  }

  private async handleInboundMessage(thread: Thread, message: Message): Promise<void> {
    const raw = message.raw as SlackEvent;
    const teamId = raw.team_id ?? raw.team;
    if (!teamId) {
      await thread.post("Slack team could not be resolved for this message.");
      return;
    }

    const binding = await this.getBindingByTeam(teamId);
    if (!binding) {
      await thread.post("This Slack workspace is not bound to a Flamecast connection.");
      return;
    }

    let teamName: string | null = null;
    try {
      const installation = await this.slack.getInstallation(teamId);
      teamName = installation?.teamName ?? null;
    } catch {
      teamName = null;
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

    const prompt = buildPromptText({
      message,
      raw,
      teamId,
      teamName,
      thread,
    });

    try {
      const result = await this.flamecast.promptCaptured(binding.connectionId, prompt);
      const assistantText = result.assistantText.trim();

      await thread.post(
        assistantText || "Prompt completed without a text response.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await thread.post(`Flamecast failed to handle this Slack message: ${message}`);
    }
  }
}

export function createSlackRoutes(slackInstaller: SlackInstaller): Hono {
  return new Hono()
    .get("/integrations/slack/install", async (c) => slackInstaller.startInstall(c.req.raw))
    .get("/integrations/slack/oauth/callback", async (c) =>
      slackInstaller.handleCallback(c.req.raw),
    )
    .post("/integrations/slack/events", async (c) => slackInstaller.handleWebhook(c.req.raw));
}
