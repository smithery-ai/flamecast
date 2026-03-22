import { describe, expect, it, vi } from "vitest";
import {
  ChatSdkDriver,
  InMemoryThreadBindingStore,
  extractMessageText,
  installChatSdkDriver,
  type ChatSdkEvent,
} from "../src/index.js";

function createEvent(overrides: Partial<ChatSdkEvent> = {}): ChatSdkEvent {
  return {
    thread: {
      id: "thread-1",
      post: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
    },
    message: {
      id: "message-1",
      text: "hello",
    },
    ...overrides,
  };
}

describe("ChatSdkDriver", () => {
  it("creates a new ACP session for a new thread and posts the reply", async () => {
    const bindings = new InMemoryThreadBindingStore();
    const sessionClient = {
      createSession: vi.fn(async () => "session-1"),
      promptSession: vi.fn(async () => ({
        stopReason: "end_turn",
        replyText: "Hi from Flamecast",
      })),
    };
    const driver = new ChatSdkDriver({
      cwd: "/workspace/flamecast",
      bindings,
      sessionClient,
    });
    const event = createEvent();

    const result = await driver.handleEvent(event);

    expect(sessionClient.createSession).toHaveBeenCalledWith("/workspace/flamecast");
    expect(sessionClient.promptSession).toHaveBeenCalledWith(
      "session-1",
      "/workspace/flamecast",
      "hello",
    );
    expect(event.thread.post).toHaveBeenCalledWith("Hi from Flamecast");
    expect(result).toMatchObject({
      threadId: "thread-1",
      sessionId: "session-1",
      createdSession: true,
      stopReason: "end_turn",
      replyText: "Hi from Flamecast",
    });
  });

  it("reuses the existing ACP session for subsequent messages in the same thread", async () => {
    const bindings = new InMemoryThreadBindingStore();
    await bindings.set({
      threadId: "thread-1",
      sessionId: "session-existing",
      createdAt: "2026-03-22T00:00:00.000Z",
      lastSeenAt: "2026-03-22T00:00:00.000Z",
    });
    const sessionClient = {
      createSession: vi.fn(async () => "session-new"),
      promptSession: vi.fn(async () => ({
        stopReason: "end_turn",
        replyText: "Welcome back",
      })),
    };
    const driver = new ChatSdkDriver({
      cwd: "/workspace/flamecast",
      bindings,
      sessionClient,
    });

    const result = await driver.handleEvent(createEvent());

    expect(sessionClient.createSession).not.toHaveBeenCalled();
    expect(sessionClient.promptSession).toHaveBeenCalledWith(
      "session-existing",
      "/workspace/flamecast",
      "hello",
    );
    expect(result?.createdSession).toBe(false);
  });

  it("subscribes new mentions and dedupes the same message across Chat SDK handlers", async () => {
    let onNewMention: ((event: ChatSdkEvent) => void | Promise<void>) | undefined;
    let onSubscribedMessage: ((event: ChatSdkEvent) => void | Promise<void>) | undefined;
    const chat = {
      onNewMention(handler: (event: ChatSdkEvent) => void | Promise<void>) {
        onNewMention = handler;
      },
      onSubscribedMessage(handler: (event: ChatSdkEvent) => void | Promise<void>) {
        onSubscribedMessage = handler;
      },
    };
    const sessionClient = {
      createSession: vi.fn(async () => "session-1"),
      promptSession: vi.fn(async () => ({
        stopReason: "end_turn",
        replyText: "Handled once",
      })),
    };
    const driver = new ChatSdkDriver({
      cwd: "/workspace/flamecast",
      bindings: new InMemoryThreadBindingStore(),
      sessionClient,
    });
    installChatSdkDriver(chat, driver);
    const event = createEvent();

    await onNewMention?.(event);
    await onSubscribedMessage?.(event);

    expect(event.thread.subscribe).toHaveBeenCalledTimes(1);
    expect(sessionClient.promptSession).toHaveBeenCalledTimes(1);
  });
});

describe("extractMessageText", () => {
  it("supports text and structured text parts", () => {
    expect(extractMessageText({ text: " hello " })).toBe("hello");
    expect(
      extractMessageText({
        parts: [
          { type: "text", text: "first" },
          { type: "image", text: "ignored" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
    expect(extractMessageText({ content: { type: "json" } })).toBeNull();
  });
});
