import type { AppType } from "@acp/flamecast/api";
import { Message, type Chat, type Thread } from "chat";
import { hc } from "hono/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkConnector, extractMessageText } from "../src/index.js";
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
  readonly startTyping: Thread["startTyping"];
  readonly subscribe: Thread["subscribe"];
  readonly unsubscribe: Thread["unsubscribe"];

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
    this.startTyping = vi.fn(async () => undefined);
    this.subscribe = overrides.subscribe ?? vi.fn(async () => undefined);
    this.unsubscribe = overrides.unsubscribe ?? vi.fn(async () => undefined);
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

function createMessage(text: string, threadId = "thread-1"): Message {
  return new Message({
    id: `message-${threadId}-${text || "empty"}`,
    threadId,
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

  const chat = {
    onNewMention(handler: MentionHandler) {
      mentionHandler = handler;
    },
    onSubscribedMessage(handler: MentionHandler) {
      subscribedHandler = handler;
    },
    webhooks: {
      slack: slackWebhook,
    },
  } as unknown as Chat;

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

function createFlamecast(fetchImpl: typeof fetch) {
  return hc<AppType>("http://flamecast.test/api", { fetch: fetchImpl });
}

function rpcLog(text: string, timestamp: string) {
  return {
    timestamp,
    type: "rpc",
    data: {
      method: "session/update",
      direction: "agent_to_client",
      phase: "notification",
      payload: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("entrypoint", () => {
  it("re-exports the minimal plugin surface", () => {
    expect(pluginEntry.ChatSdkConnector).toBe(ChatSdkConnector);
    expect(pluginEntry.extractMessageText).toBe(extractMessageText);
  });
});

describe("extractMessageText", () => {
  it("returns trimmed Chat SDK message text when present", () => {
    expect(extractMessageText(createMessage(" hello "))).toBe("hello");
    expect(extractMessageText(createMessage("   "))).toBeNull();
  });
});

describe("ChatSdkConnector", () => {
  it("creates agents on first mention, reuses them for follow-ups, updates thread references, and ignores empty messages", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [rpcLog("first", "1")] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [rpcLog("first", "1")] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "agent-1",
            logs: [rpcLog("first", "1"), rpcLog("second", "2")],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "agent-1",
            logs: [rpcLog("first", "1"), rpcLog("second", "2")],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "agent-1",
            logs: [rpcLog("first", "1"), rpcLog("second", "2"), rpcLog("third", "3")],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    connector.start();

    const firstThread = createThread("thread-1");
    await chat.emitMention(firstThread, createMessage("hello", "thread-1"));
    await chat.emitSubscribed(firstThread, createMessage("same-thread", "thread-1"));

    const refreshedThread = createThread("thread-1");
    await chat.emitSubscribed(refreshedThread, createMessage("follow-up", "thread-1"));
    await chat.emitSubscribed(refreshedThread, createMessage("   ", "thread-1"));

    expect(firstThread.subscribe).toHaveBeenCalledTimes(1);
    expect(firstThread.post).toHaveBeenNthCalledWith(1, "first");
    expect(firstThread.post).toHaveBeenNthCalledWith(2, "second");
    expect(refreshedThread.post).toHaveBeenCalledWith("third");

    const createAgentCalls = fetchImpl.mock.calls.filter(
      ([url, init]) => url === "http://flamecast.test/api/agents" && init?.method === "POST",
    );
    expect(createAgentCalls).toHaveLength(1);

    const health = await connector.fetch(new Request("http://connector.test/health"));
    expect(await health.json()).toEqual({ status: "ok", bindings: 1 });
  });

  it("skips posting when the appended logs do not contain a text assistant reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
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

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    const thread = createThread("thread-1");
    await chat.emitMention(thread, createMessage("hello", "thread-1"));

    expect(thread.post).not.toHaveBeenCalled();
  });

  it("surfaces agent creation errors from JSON error responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "agent failed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { spawn: { command: "node", args: [] }, cwd: "/workspace" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    await expect(chat.emitMention(createThread("thread-1"), createMessage("hello", "thread-1"))).rejects.toThrow(
      "agent failed",
    );
  });

  it("falls back to the HTTP status text when a JSON error payload omits the error field", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "bad gateway" }), {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "application/json" },
      }),
    );

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    await expect(chat.emitMention(createThread("thread-1"), createMessage("hello", "thread-1"))).rejects.toThrow(
      "Bad Gateway",
    );
  });

  it("surfaces snapshot errors before prompting", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Agent not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    await expect(chat.emitMention(createThread("thread-1"), createMessage("hello", "thread-1"))).rejects.toThrow(
      "Agent not found",
    );
  });

  it("surfaces prompt errors from JSON error responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "prompt failed" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    await expect(chat.emitMention(createThread("thread-1"), createMessage("hello", "thread-1"))).rejects.toThrow(
      "prompt failed",
    );
  });

  it("falls back to a synthesized status message for non-json errors without status text", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502, statusText: "" }));

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    await expect(chat.emitMention(createThread("thread-1"), createMessage("hello", "thread-1"))).rejects.toThrow(
      "Request failed with status 502",
    );
  });

  it("stops cleanly, continues cleanup when one delete request rejects, and ignores new messages after stop", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-1", logs: [rpcLog("one", "1")] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-2", logs: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-2", logs: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agent-2", logs: [rpcLog("two", "2")] }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(fetchImpl),
    });

    connector.start();
    await chat.emitMention(createThread("thread-1"), createMessage("one", "thread-1"));
    await chat.emitMention(createThread("thread-2"), createMessage("two", "thread-2"));

    await expect(connector.stop()).resolves.toBeUndefined();

    const lateThread = createThread("thread-3");
    const callsBeforeLateMessage = fetchImpl.mock.calls.length;
    await chat.emitMention(lateThread, createMessage("ignored", "thread-3"));

    expect(lateThread.subscribe).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls).toHaveLength(callsBeforeLateMessage);
  });

  it("serves health and webhook routes", async () => {
    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      agent: { agentTemplateId: "codex" },
      chat: chat.chat,
      flamecast: createFlamecast(vi.fn<typeof fetch>()),
    });

    const health = await connector.fetch(new Request("http://connector.test/health"));
    expect(await health.json()).toEqual({ status: "ok", bindings: 0 });

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
});
