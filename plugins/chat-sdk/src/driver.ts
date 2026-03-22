export type ChatSdkThread = {
  id: string;
  post(message: string): Promise<unknown>;
  subscribe?(): Promise<unknown>;
};

export type ChatSdkMessage = {
  id?: string;
  text?: string;
  content?: unknown;
  parts?: Array<{ type?: string; text?: string }>;
};

export type ChatSdkEvent = {
  thread: ChatSdkThread;
  message: ChatSdkMessage;
};

export type ChatSdkEventSource = {
  onNewMention?(handler: (event: ChatSdkEvent) => void | Promise<void>): void;
  onSubscribedMessage?(handler: (event: ChatSdkEvent) => void | Promise<void>): void;
};

export type DriverPromptResult = {
  stopReason: string;
  replyText: string;
};

export type DriverSessionClient = {
  createSession(cwd: string): Promise<string>;
  promptSession(sessionId: string, cwd: string, text: string): Promise<DriverPromptResult>;
};

export type ThreadBinding = {
  threadId: string;
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
};

export type ThreadBindingStore = {
  get(threadId: string): Promise<ThreadBinding | null>;
  set(binding: ThreadBinding): Promise<void>;
  touch(threadId: string, timestamp: string): Promise<void>;
};

export type ChatSdkDriverOptions = {
  cwd: string;
  sessionClient: DriverSessionClient;
  bindings: ThreadBindingStore;
};

export type ChatSdkInstallOptions = {
  handleNewMentions?: boolean;
  handleSubscribedMessages?: boolean;
  subscribeOnNewMention?: boolean;
};

export type ChatSdkHandleResult = {
  threadId: string;
  sessionId: string;
  createdSession: boolean;
  replyText: string;
  stopReason: string;
};

export class ChatSdkDriver {
  private readonly cwd: string;
  private readonly sessionClient: DriverSessionClient;
  private readonly bindings: ThreadBindingStore;
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageOrder: string[] = [];

  constructor(options: ChatSdkDriverOptions) {
    this.cwd = options.cwd;
    this.sessionClient = options.sessionClient;
    this.bindings = options.bindings;
  }

  async handleEvent(event: ChatSdkEvent): Promise<ChatSdkHandleResult | null> {
    const text = extractMessageText(event.message);
    if (!text) {
      return null;
    }

    const now = new Date().toISOString();
    const existingBinding = await this.bindings.get(event.thread.id);
    const sessionId =
      existingBinding?.sessionId ?? (await this.sessionClient.createSession(this.cwd));

    if (existingBinding) {
      await this.bindings.touch(event.thread.id, now);
    } else {
      await this.bindings.set({
        threadId: event.thread.id,
        sessionId,
        createdAt: now,
        lastSeenAt: now,
      });
    }

    const result = await this.sessionClient.promptSession(sessionId, this.cwd, text);
    if (result.replyText.trim()) {
      await event.thread.post(result.replyText);
    }

    return {
      threadId: event.thread.id,
      sessionId,
      createdSession: existingBinding === null,
      replyText: result.replyText,
      stopReason: result.stopReason,
    };
  }

  install(chat: ChatSdkEventSource, options: ChatSdkInstallOptions = {}): void {
    const handleEvent = async (event: ChatSdkEvent, shouldSubscribe: boolean) => {
      if (this.isDuplicate(event.message.id)) {
        return;
      }

      if (shouldSubscribe && typeof event.thread.subscribe === "function") {
        await event.thread.subscribe();
      }

      await this.handleEvent(event);
    };

    if (options.handleNewMentions !== false && typeof chat.onNewMention === "function") {
      chat.onNewMention((event) => handleEvent(event, options.subscribeOnNewMention !== false));
    }

    if (
      options.handleSubscribedMessages !== false &&
      typeof chat.onSubscribedMessage === "function"
    ) {
      chat.onSubscribedMessage((event) => handleEvent(event, false));
    }
  }

  private isDuplicate(messageId?: string): boolean {
    if (!messageId) {
      return false;
    }

    if (this.seenMessageIds.has(messageId)) {
      return true;
    }

    this.seenMessageIds.add(messageId);
    this.seenMessageOrder.push(messageId);

    if (this.seenMessageOrder.length > 1_000) {
      const oldest = this.seenMessageOrder.shift();
      if (oldest) {
        this.seenMessageIds.delete(oldest);
      }
    }

    return false;
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
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  return null;
}

export function installChatSdkDriver(
  chat: ChatSdkEventSource,
  driver: ChatSdkDriver,
  options?: ChatSdkInstallOptions,
): void {
  driver.install(chat, options);
}
