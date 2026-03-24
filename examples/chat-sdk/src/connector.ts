import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ChatSdkThread, SqlThreadAgentBindingStore, ThreadAgentBinding } from "./bindings.js";
import {
  createConnectorMcpServer,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
} from "./flamecast.js";
import { handleChatMcpRequest } from "./mcp.js";

export type ChatSdkMessage = {
  content?: unknown;
  parts?: Array<{ text?: string; type?: string }> | null;
  text?: string | null;
};

type MentionHandler = (thread: ChatSdkThread, message: ChatSdkMessage) => void | Promise<void>;

type WebhookHandler = (
  request: Request,
  context: { waitUntil(task: Promise<unknown>): void },
) => Promise<Response>;

export type ChatSdkClient = {
  onNewMention(handler: MentionHandler): void;
  onSubscribedMessage(handler: MentionHandler): void;
  webhooks: Record<string, WebhookHandler>;
};

export type ChatSdkConnectorOptions = {
  chat: ChatSdkClient;
  flamecast: FlamecastAgentClient;
  bindings: SqlThreadAgentBindingStore;
  agent: Omit<FlamecastCreateAgentBody, "mcpServers">;
  mcpEndpoint: string | URL;
  mcpHeaderName?: string;
  mcpServerName?: string;
};

export type { ChatSdkThread } from "./bindings.js";

export class ChatSdkConnector {
  private readonly chat: ChatSdkClient;
  private readonly flamecast: FlamecastAgentClient;
  private readonly bindings: SqlThreadAgentBindingStore;
  private readonly agent: Omit<FlamecastCreateAgentBody, "mcpServers">;
  private readonly mcpEndpoint: URL;
  private readonly mcpHeaderName: string;
  private readonly mcpServerName?: string;
  private readonly app = new Hono();
  private readonly threads = new Map<string, ChatSdkThread>();
  private handlersInstalled = false;
  private active = false;

  readonly fetch: (request: Request) => Promise<Response>;

  constructor(options: ChatSdkConnectorOptions) {
    this.chat = options.chat;
    this.flamecast = options.flamecast;
    this.bindings = options.bindings;
    this.agent = options.agent;
    this.mcpEndpoint = new URL(options.mcpEndpoint);
    this.mcpHeaderName = options.mcpHeaderName ?? "x-flamecast-chat-token";
    this.mcpServerName = options.mcpServerName;
    this.fetch = async (request: Request) => this.app.fetch(request);

    this.app.get("/health", async (c) =>
      c.json({
        status: "ok",
        bindings: (await this.bindings.list()).length,
      }),
    );
    this.app.post("/webhooks/:platform", async (c) =>
      this.handleWebhookRequest(c.req.param("platform"), c.req.raw),
    );
    this.app.all("/mcp", async (c) => this.handleMcpRequest(c.req.raw));
  }

  start(): void {
    this.active = true;
    if (this.handlersInstalled) {
      return;
    }

    this.chat.onNewMention((thread, message) => this.handleNewMention(thread, message));
    this.chat.onSubscribedMessage((thread, message) =>
      this.handleSubscribedMessage(thread, message),
    );
    this.handlersInstalled = true;
  }

  async stop(): Promise<void> {
    this.active = false;
    const bindings = await this.bindings.list();
    await Promise.all(
      bindings.map(async (binding) => {
        await this.flamecast.terminateAgent(binding.agentId).catch(() => undefined);
      }),
    );
    await this.bindings.clear();
    this.threads.clear();
  }

  async handleNewMention(thread: ChatSdkThread, message: ChatSdkMessage): Promise<void> {
    await this.handleInboundMessage(thread, message);
  }

  async handleSubscribedMessage(thread: ChatSdkThread, message: ChatSdkMessage): Promise<void> {
    await this.handleInboundMessage(thread, message);
  }

  async handleWebhookRequest(platform: string, request: Request): Promise<Response> {
    const handler = this.chat.webhooks[platform];
    if (!handler) {
      return new Response(JSON.stringify({ error: "Unknown webhook platform" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return handler(request, {
      waitUntil(task) {
        void task.catch(() => undefined);
      },
    });
  }

  async handleMcpRequest(request: Request): Promise<Response> {
    const token = request.headers.get(this.mcpHeaderName);
    if (!token) {
      return this.jsonError("Missing MCP auth token", 401);
    }

    const binding = await this.bindings.getByAuthToken(token);
    if (!binding) {
      return this.jsonError("Unknown MCP auth token", 401);
    }

    const thread = this.threads.get(binding.threadId);
    if (!thread) {
      return this.jsonError("Thread is not active in this connector process", 409);
    }

    return handleChatMcpRequest(request, {
      binding,
      thread,
      bindings: this.bindings,
      flamecast: this.flamecast,
      forgetThread: (threadId) => {
        this.threads.delete(threadId);
      },
    });
  }

  private async handleInboundMessage(
    thread: ChatSdkThread,
    message: ChatSdkMessage,
  ): Promise<void> {
    if (!this.active) {
      return;
    }

    const text = extractMessageText(message);
    if (!text) {
      return;
    }

    this.threads.set(thread.id, thread);

    let binding = await this.bindings.getByThreadId(thread.id);
    if (!binding) {
      await thread.subscribe?.();
      binding = await this.createBinding(thread);
    }

    await this.flamecast.promptAgent(binding.agentId, text);
  }

  private async createBinding(thread: ChatSdkThread): Promise<ThreadAgentBinding> {
    const authToken = randomUUID();
    const agent = await this.flamecast.createAgent({
      ...this.agent,
      mcpServers: [
        createConnectorMcpServer(this.mcpEndpoint, authToken, {
          headerName: this.mcpHeaderName,
          serverName: this.mcpServerName,
        }),
      ],
    });
    const binding: ThreadAgentBinding = {
      threadId: thread.id,
      agentId: agent.id,
      authToken,
    };
    await this.bindings.set(binding);
    return binding;
  }

  private jsonError(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

export function extractMessageText(message: ChatSdkMessage): string | null {
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }

  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }

  if (Array.isArray(message.parts)) {
    const text = message.parts
      .filter(
        (
          part,
        ): part is {
          type: string;
          text: string;
        } => part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  return null;
}
