import type { Chat, Message, Thread } from "chat";
import { Hono } from "hono";
import type { InMemoryThreadBindingStore, ThreadBinding } from "./bindings.js";

export type ChatSdkClient = Pick<Chat, "onNewMention" | "onSubscribedMessage" | "webhooks">;

export type ChatSdkConnectorMessageContext = {
  binding: ThreadBinding;
  message: Message;
  text: string;
  thread: Thread;
};

export type ChatSdkConnectorOptions = {
  chat: ChatSdkClient;
  bindings: InMemoryThreadBindingStore;
  createBinding(thread: Thread): Promise<ThreadBinding>;
  onBindingRemoved?(binding: ThreadBinding): void | Promise<void>;
  onMessage(
    context: ChatSdkConnectorMessageContext,
  ): Promise<string | null | void> | string | null | void;
};

export type { Message as ChatSdkMessage, Thread as ChatSdkThread, ThreadBinding };

export class ChatSdkConnector {
  private readonly chat: ChatSdkClient;
  private readonly bindings: InMemoryThreadBindingStore;
  private readonly createBindingCallback: (thread: Thread) => Promise<ThreadBinding>;
  private readonly onBindingRemoved?: (binding: ThreadBinding) => void | Promise<void>;
  private readonly onMessageCallback: ChatSdkConnectorOptions["onMessage"];
  private readonly app = new Hono();
  private handlersInstalled = false;
  private active = false;

  readonly fetch: (request: Request) => Promise<Response>;

  constructor(options: ChatSdkConnectorOptions) {
    this.chat = options.chat;
    this.bindings = options.bindings;
    this.createBindingCallback = options.createBinding;
    this.onBindingRemoved = options.onBindingRemoved;
    this.onMessageCallback = options.onMessage;
    this.fetch = async (request: Request) => this.app.fetch(request);

    this.app.get("/health", (c) =>
      c.json({
        status: "ok",
        bindings: this.bindings.list().length,
      }),
    );
    this.app.post("/webhooks/:platform", async (c) =>
      this.handleWebhookRequest(c.req.param("platform"), c.req.raw),
    );
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
    const bindings = this.bindings.list();
    await Promise.all(
      bindings.map(async (binding) => {
        await Promise.resolve(this.onBindingRemoved?.(binding)).catch(() => undefined);
      }),
    );
    this.bindings.clear();
  }

  async handleNewMention(thread: Thread, message: Message): Promise<void> {
    await this.handleInboundMessage(thread, message);
  }

  async handleSubscribedMessage(thread: Thread, message: Message): Promise<void> {
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

  private async handleInboundMessage(thread: Thread, message: Message): Promise<void> {
    if (!this.active) {
      return;
    }

    const text = extractMessageText(message);
    if (!text) {
      return;
    }

    let binding = this.bindings.getByThreadId(thread.id);
    if (!binding) {
      await thread.subscribe();
      binding = await this.createBinding(thread);
    } else if (binding.thread !== thread) {
      binding = {
        ...binding,
        thread,
      };
      this.bindings.set(binding);
    }

    const reply = await this.onMessageCallback({
      binding,
      message,
      text,
      thread,
    });
    const replyText = typeof reply === "string" ? reply.trim() : "";

    if (replyText) {
      await thread.post(replyText);
    }
  }

  private async createBinding(thread: Thread): Promise<ThreadBinding> {
    const binding = await this.createBindingCallback(thread);
    const normalizedBinding: ThreadBinding = {
      ...binding,
      threadId: thread.id,
      thread,
    };
    this.bindings.set(normalizedBinding);
    return normalizedBinding;
  }
}

export function extractMessageText(message: Message): string | null {
  const text = message.text.trim();
  return text || null;
}
