import { Message, type Chat, type Thread } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatSdkConnector,
  type ChatSdkClient,
  type FlamecastCreateAgentBody,
  FlamecastHttpClient,
  InMemoryThreadBindingStore,
  extractMessageText,
} from "../src/index.js";
import * as pluginEntry from "../src/index.js";

type MentionHandler = (thread: Thread, message: Message) => Promise<void> | void;

class TestSentMessage extends Message {
  constructor(threadId: string) {
    super({
      id: `sent-${threadId}`,
      threadId,
      text: "sent",
      formatted: { type: "root", children: [] },
      raw: {},
      author: {
        userId: "bot",
        userName: "bot",
        fullName: "Bot",
        isBot: true,
        isMe: true,
      },
      metadata: {
        dateSent: new Date(0),
        edited: false,
      },
      attachments: [],
      links: [],
    });
  }

  async addReaction(_emoji: string): Promise<void> {}

  async delete(): Promise<void> {}

  async edit(_newContent: string): Promise<TestSentMessage> {
    return this;
  }

  async removeReaction(_emoji: string): Promise<void> {}
}

class TestThread implements Thread {
  readonly id: string;
  readonly channelId: string;
  readonly isDM = false;
  readonly recentMessages: Message[] = [];
  readonly messages = (async function* () {})();
  readonly allMessages = (async function* () {})();
  readonly state = Promise.resolve(null);
  readonly post: Thread["post"];
  readonly subscribe: Thread["subscribe"];
  readonly unsubscribe: Thread["unsubscribe"];
  readonly startTyping: Thread["startTyping"];

  constructor(
    id: string,
    overrides: Partial<{
      post: Thread["post"];
      subscribe: Thread["subscribe"];
      unsubscribe: Thread["unsubscribe"];
    }> = {},
  ) {
    this.id = id;
    this.channelId = `channel-${id}`;
    this.post = overrides.post ?? vi.fn(async () => new TestSentMessage(id));
    this.subscribe = overrides.subscribe ?? vi.fn(async () => undefined);
    this.unsubscribe = overrides.unsubscribe ?? vi.fn(async () => undefined);
    this.startTyping = vi.fn(async () => undefined);
  }

  get adapter(): Thread["adapter"] {
    throw new Error("Not used in tests");
  }

  get channel(): Thread["channel"] {
    throw new Error("Not used in tests");
  }

  createSentMessageFromMessage(message: Message): TestSentMessage {
    return new TestSentMessage(message.threadId);
  }

  async isSubscribed(): Promise<boolean> {
    return true;
  }

  mentionUser(userId: string): string {
    return `@${userId}`;
  }

  async postEphemeral(): Promise<null> {
    return null;
  }

  async refresh(): Promise<void> {}

  async schedule(): Promise<never> {
    throw new Error("Not used in tests");
  }

  async setState(): Promise<void> {}
}

function createThread(
  id: string,
  overrides: Partial<{
    post: Thread["post"];
    subscribe: Thread["subscribe"];
    unsubscribe: Thread["unsubscribe"];
  }> = {},
): Thread {
  return new TestThread(id, overrides);
}

function createMessage(text: string): Message {
  return new Message({
    id: `message-${text || "empty"}`,
    threadId: "thread-1",
    text,
    formatted: { type: "root", children: [] },
    raw: {},
    author: {
      userId: "user-1",
      userName: "user",
      fullName: "User",
      isBot: false,
      isMe: false,
    },
    metadata: {
      dateSent: new Date(0),
      edited: false,
    },
    attachments: [],
    links: [],
  });
}

function createChatStub() {
  let mentionHandler: MentionHandler | null = null;
  let subscribedHandler: MentionHandler | null = null;
  const slackWebhook = vi.fn(
    async (
      _request: Request,
      options?: { waitUntil?: (task: Promise<unknown>) => void },
    ): Promise<Response> => {
      options?.waitUntil?.(Promise.reject(new Error("ignored")));
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const chat: ChatSdkClient = {
    onNewMention(handler: MentionHandler) {
      mentionHandler = handler;
    },
    onSubscribedMessage(handler: MentionHandler) {
      subscribedHandler = handler;
    },
    webhooks: {
      slack: slackWebhook,
    },
  } satisfies Pick<Chat, "onNewMention" | "onSubscribedMessage" | "webhooks">;

  return {
    chat,
    async emitMention(thread: Thread, message: Message) {
      await mentionHandler?.(thread, message);
    },
    async emitSubscribed(thread: Thread, message: Message) {
      await subscribedHandler?.(thread, message);
    },
    slackWebhook,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("InMemoryThreadBindingStore", () => {
  it("stores, updates, deletes, and clears bindings", () => {
    const store = new InMemoryThreadBindingStore();
    const firstThread = createThread("thread-1");

    expect(store.getByThreadId("missing")).toBeNull();
    expect(store.getByBindingId("missing")).toBeNull();
    expect(store.deleteByThreadId("missing")).toBeNull();

    store.set({
      threadId: "thread-1",
      bindingId: "binding-1",
      thread: firstThread,
    });

    expect(store.list()).toHaveLength(1);
    expect(store.getByThreadId("thread-1")?.thread).toBe(firstThread);
    expect(store.getByBindingId("binding-1")?.threadId).toBe("thread-1");

    const nextThread = createThread("thread-1");
    store.set({
      threadId: "thread-1",
      bindingId: "binding-2",
      thread: nextThread,
    });

    expect(store.getByBindingId("binding-1")).toBeNull();
    expect(store.getByThreadId("thread-1")?.thread).toBe(nextThread);
    expect(store.deleteByThreadId("thread-1")?.bindingId).toBe("binding-2");
    expect(store.list()).toEqual([]);

    store.set({
      threadId: "thread-2",
      bindingId: "binding-3",
      thread: createThread("thread-2"),
    });
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("returns null when the secondary index points at a missing thread record", () => {
    const store = new InMemoryThreadBindingStore();
    store.set({
      threadId: "thread-1",
      bindingId: "binding-1",
      thread: createThread("thread-1"),
    });

    const byThreadId = Reflect.get(store, "byThreadId");
    if (!(byThreadId instanceof Map)) {
      throw new Error("Expected byThreadId to be a Map");
    }
    byThreadId.delete("thread-1");

    expect(store.getByBindingId("binding-1")).toBeNull();
  });
});

describe("extractMessageText", () => {
  it("returns trimmed Chat SDK message text when present", () => {
    expect(extractMessageText(createMessage(" hello "))).toBe("hello");
    expect(extractMessageText(createMessage("   "))).toBeNull();
  });
});

describe("FlamecastHttpClient", () => {
  it("re-exports the plugin entrypoint surface", () => {
    expect(pluginEntry.ChatSdkConnector).toBe(ChatSdkConnector);
    expect(pluginEntry.FlamecastHttpClient).toBe(FlamecastHttpClient);
    expect(pluginEntry.extractMessageText).toBe(extractMessageText);
  });

  it("creates agents, prompts agents, and terminates agents", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    expect(
      await client.createAgent({
        spawn: { command: "node", args: ["agent.js"] },
        cwd: "/workspace",
      }),
    ).toEqual({
      id: "agent-1",
      logs: [],
    });
    expect(await client.promptAgent("agent-1", "hello")).toEqual({
      stopReason: "end_turn",
    });
    await client.terminateAgent("agent-1");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      new URL("/api/agents", "http://flamecast.test"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      new URL("/api/agents/agent-1/prompt", "http://flamecast.test"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      new URL("/api/agents/agent-1", "http://flamecast.test"),
      { method: "DELETE" },
    );
  });

  it("handles agent snapshots without logs when deriving a reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "agent-1" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "agent-1" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new FlamecastHttpClient({ baseUrl: "http://flamecast.test", fetch: fetchImpl });

    expect(await client.promptAgentForReply("agent-1", "hello")).toEqual({
      stopReason: "end_turn",
      replyText: null,
    });
  });

  it("returns null when appended logs do not contain a text assistant reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "agent-1",
          logs: [
            { timestamp: "1", type: "session_update", data: {} },
            {
              timestamp: "2",
              type: "rpc",
              data: {
                method: "session/prompt",
                direction: "agent_to_client",
                phase: "notification",
                payload: {},
              },
            },
            {
              timestamp: "3",
              type: "rpc",
              data: {
                method: "session/update",
                direction: "agent_to_client",
                phase: "notification",
                payload: {
                  update: {
                    sessionUpdate: "tool_call",
                    content: { type: "text", text: "ignored" },
                  },
                },
              },
            },
            {
              timestamp: "4",
              type: "rpc",
              data: {
                method: "session/update",
                direction: "agent_to_client",
                phase: "notification",
                payload: {
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "image", text: "ignored" },
                  },
                },
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const client = new FlamecastHttpClient({ baseUrl: "http://flamecast.test", fetch: fetchImpl });

    expect(await client.promptAgentForReply("agent-1", "hello")).toEqual({
      stopReason: "end_turn",
      replyText: null,
    });
  });

  it("derives the latest assistant reply from newly appended logs", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "agent-1",
          logs: [{ timestamp: "1", type: "rpc", data: { method: "session/prompt" } }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "agent-1",
          logs: [
            { timestamp: "1", type: "rpc", data: { method: "session/prompt" } },
            {
              timestamp: "2",
              type: "rpc",
              data: {
                method: "session/update",
                direction: "agent_to_client",
                phase: "notification",
                payload: {
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Hello" },
                  },
                },
              },
            },
            {
              timestamp: "3",
              type: "rpc",
              data: {
                method: "session/update",
                direction: "agent_to_client",
                phase: "notification",
                payload: {
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: " world" },
                  },
                },
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const client = new FlamecastHttpClient({ baseUrl: "http://flamecast.test", fetch: fetchImpl });

    expect(await client.promptAgentForReply("agent-1", "hello")).toEqual({
      stopReason: "end_turn",
      replyText: "Hello world",
    });
  });

  it("surfaces JSON and non-JSON error responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "agent failed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    await expect(
      client.createAgent({
        spawn: { command: "node" },
        cwd: "/workspace",
      }),
    ).rejects.toThrow("agent failed");
    await expect(client.terminateAgent("agent-1")).rejects.toThrow("Bad Gateway");
  });

  it("uses the global fetch fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
    });

    expect(await client.promptAgent("agent 1", "hello")).toEqual({
      stopReason: "end_turn",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("/api/agents/agent%201/prompt", "http://flamecast.test"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to a synthesized status message for non-json errors without status text", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(new Response("bad gateway", { status: 502, statusText: "" }));
    const client = new FlamecastHttpClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    await expect(client.terminateAgent("agent-1")).rejects.toThrow(
      "Request failed with status 502",
    );
  });
});

describe("ChatSdkConnector", () => {
  function createCallbacks() {
    let counter = 0;
    return {
      createBinding: vi.fn(async (thread: Thread) => ({
        threadId: thread.id,
        bindingId: `binding-${++counter}`,
        thread,
      })),
      onMessage: vi.fn<
        ({
          binding,
          text,
        }: {
          binding: { bindingId: string };
          text: string;
        }) => Promise<string | undefined>
      >(
        async ({ binding, text }: { binding: { bindingId: string }; text: string }) =>
          `${binding.bindingId}:${text}`,
      ),
      onBindingRemoved: vi.fn(async () => undefined),
    };
  }

  it("creates bindings on first mention, reuses them for follow-ups, and ignores empty messages", async () => {
    const bindings = new InMemoryThreadBindingStore();
    const chat = createChatStub();
    const callbacks = createCallbacks();
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      bindings,
      createBinding: callbacks.createBinding,
      onMessage: callbacks.onMessage,
      onBindingRemoved: callbacks.onBindingRemoved,
    });

    connector.start();
    connector.start();

    const firstThread = createThread("thread-1");
    await chat.emitMention(firstThread, createMessage("hello"));

    expect(firstThread.subscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.createBinding).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        binding: expect.objectContaining({ bindingId: "binding-1" }),
      }),
    );
    expect(firstThread.post).toHaveBeenCalledWith("binding-1:hello");
    expect(bindings.getByThreadId("thread-1")?.bindingId).toBe("binding-1");

    await chat.emitSubscribed(firstThread, createMessage("same-thread"));

    const refreshedThread = createThread("thread-1");
    await chat.emitSubscribed(refreshedThread, createMessage("follow-up"));
    await chat.emitSubscribed(refreshedThread, createMessage("   "));

    expect(callbacks.createBinding).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "same-thread",
        binding: expect.objectContaining({ bindingId: "binding-1" }),
      }),
    );
    expect(callbacks.onMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        text: "follow-up",
        binding: expect.objectContaining({ bindingId: "binding-1" }),
      }),
    );
    expect(bindings.getByThreadId("thread-1")?.thread).toBe(refreshedThread);
  });

  it("skips posting when the message handler returns nothing", async () => {
    const bindings = new InMemoryThreadBindingStore();
    const chat = createChatStub();
    const callbacks = createCallbacks();
    callbacks.onMessage.mockImplementationOnce(async () => undefined);
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      bindings,
      createBinding: callbacks.createBinding,
      onMessage: callbacks.onMessage,
    });

    connector.start();
    const thread = createThread("thread-1");
    await chat.emitMention(thread, createMessage("hello"));

    expect(thread.post).not.toHaveBeenCalled();
  });

  it("posts only non-empty replies", async () => {
    const bindings = new InMemoryThreadBindingStore();
    const chat = createChatStub();
    const callbacks = createCallbacks();
    callbacks.onMessage.mockResolvedValueOnce("   ");
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      bindings,
      createBinding: callbacks.createBinding,
      onMessage: callbacks.onMessage,
    });

    connector.start();
    const thread = createThread("thread-1");
    await chat.emitMention(thread, createMessage("hello"));

    expect(thread.post).not.toHaveBeenCalled();
  });

  it("stops cleanly and continues cleanup when one binding removal fails", async () => {
    const bindings = new InMemoryThreadBindingStore();
    const chat = createChatStub();
    const callbacks = createCallbacks();
    callbacks.onBindingRemoved
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      bindings,
      createBinding: callbacks.createBinding,
      onMessage: callbacks.onMessage,
      onBindingRemoved: callbacks.onBindingRemoved,
    });

    connector.start();
    await chat.emitMention(createThread("thread-1"), createMessage("one"));
    await chat.emitMention(createThread("thread-2"), createMessage("two"));

    await expect(connector.stop()).resolves.toBeUndefined();
    await chat.emitMention(createThread("thread-3"), createMessage("ignored"));

    expect(callbacks.onBindingRemoved).toHaveBeenCalledTimes(2);
    expect(bindings.list()).toEqual([]);
    expect(callbacks.createBinding).toHaveBeenCalledTimes(2);
  });

  it("serves health and webhook routes", async () => {
    const bindings = new InMemoryThreadBindingStore();
    bindings.set({
      threadId: "thread-1",
      bindingId: "binding-1",
      thread: createThread("thread-1"),
    });
    const chat = createChatStub();
    const callbacks = createCallbacks();
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      bindings,
      createBinding: callbacks.createBinding,
      onMessage: callbacks.onMessage,
    });

    const health = await connector.fetch(new Request("http://connector.test/health"));
    expect(await health.json()).toEqual({ status: "ok", bindings: 1 });

    const webhook = await connector.fetch(
      new Request("http://connector.test/webhooks/slack", {
        method: "POST",
      }),
    );
    expect(webhook.status).toBe(202);
    expect(await webhook.json()).toEqual({ ok: true });
    expect(chat.slackWebhook).toHaveBeenCalledTimes(1);

    const missing = await connector.fetch(
      new Request("http://connector.test/webhooks/discord", {
        method: "POST",
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Unknown webhook platform" });
  });

  it("allows Flamecast integrations to stay outside the connector", async () => {
    const chat = createChatStub();
    const flamecast = {
      createAgent: vi.fn(async (_body: FlamecastCreateAgentBody) => ({ id: "agent-1", logs: [] })),
      promptAgentForReply: vi.fn(async (_agentId: string, _text: string) => ({
        stopReason: "end_turn",
        replyText: "assistant reply",
      })),
      terminateAgent: vi.fn(async (_agentId: string) => undefined),
    };
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      bindings: new InMemoryThreadBindingStore(),
      createBinding: async (thread) => {
        const agent = await flamecast.createAgent({ agentTemplateId: "codex" });
        return { threadId: thread.id, bindingId: agent.id, thread };
      },
      onMessage: async ({ binding, text }) => {
        const result = await flamecast.promptAgentForReply(binding.bindingId, text);
        return result.replyText;
      },
      onBindingRemoved: async ({ bindingId }) => {
        await flamecast.terminateAgent(bindingId);
      },
    });

    connector.start();
    const thread = createThread("thread-1");
    await chat.emitMention(thread, createMessage("hello"));
    await connector.stop();

    expect(flamecast.createAgent).toHaveBeenCalledWith({ agentTemplateId: "codex" });
    expect(flamecast.promptAgentForReply).toHaveBeenCalledWith("agent-1", "hello");
    expect(thread.post).toHaveBeenCalledWith("assistant reply");
    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-1");
  });
});
