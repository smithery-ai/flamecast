import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatSdkConnector,
  SqlThreadAgentBindingStore,
  type ChatSdkClient,
  type ChatSdkMessage,
  type ChatSdkThread,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  createConnectorMcpServer,
  createFlamecastAgentClient,
  extractMessageText,
} from "../src/index.js";
import * as pluginEntry from "../src/index.js";

type MentionHandler = (thread: ChatSdkThread, message: ChatSdkMessage) => Promise<void> | void;

const cleanups: Array<() => Promise<void>> = [];

function createThread(
  id: string,
  overrides: Partial<{
    post: ChatSdkThread["post"];
    startTyping: ChatSdkThread["startTyping"];
    subscribe: ChatSdkThread["subscribe"];
    unsubscribe: ChatSdkThread["unsubscribe"];
  }> = {},
): ChatSdkThread {
  return {
    id,
    post: overrides.post ?? vi.fn(async () => ({ id: `sent-${id}` })),
    startTyping: "startTyping" in overrides ? overrides.startTyping : vi.fn(async () => undefined),
    subscribe: "subscribe" in overrides ? overrides.subscribe : vi.fn(async () => undefined),
    unsubscribe: "unsubscribe" in overrides ? overrides.unsubscribe : vi.fn(async () => undefined),
  };
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
  };

  return {
    chat: {
      ...chat,
    },
    async emitMention(thread: ChatSdkThread, message: ChatSdkMessage) {
      await mentionHandler?.(thread, message);
    },
    async emitSubscribed(thread: ChatSdkThread, message: ChatSdkMessage) {
      await subscribedHandler?.(thread, message);
    },
    slackWebhook,
  };
}

function createFlamecastStub(): FlamecastAgentClient & {
  createAgent: ReturnType<typeof vi.fn>;
  promptAgent: ReturnType<typeof vi.fn>;
  terminateAgent: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  return {
    createAgent: vi.fn(async (_body: FlamecastCreateAgentBody) => ({
      id: `agent-${++counter}`,
    })),
    promptAgent: vi.fn(async () => ({ stopReason: "end_turn" })),
    terminateAgent: vi.fn(async () => undefined),
  };
}

function createAppFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return handler(request);
  };
}

async function createBindingsStore(): Promise<SqlThreadAgentBindingStore> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "flamecast-chat-sdk-"));
  const store = await SqlThreadAgentBindingStore.create({
    pgliteDataDir: dataDir,
  });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function connectMcp(connector: ChatSdkConnector, token: string) {
  const client = new Client({ name: "connector-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL("http://connector.test/mcp"), {
    fetch: createAppFetch(connector.fetch),
    requestInit: {
      headers: {
        "x-flamecast-chat-token": token,
      },
    },
  });

  await client.connect(transport);
  return { client, transport };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

describe("SqlThreadAgentBindingStore", () => {
  it("stores, updates, deletes, and clears bindings", async () => {
    const store = await createBindingsStore();

    expect(await store.getByThreadId("missing")).toBeNull();
    expect(await store.getByAgentId("missing")).toBeNull();
    expect(await store.getByAuthToken("missing")).toBeNull();
    expect(await store.deleteByThreadId("missing")).toBeNull();

    await store.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });

    expect(await store.list()).toEqual([
      {
        threadId: "thread-1",
        agentId: "agent-1",
        authToken: "token-1",
      },
    ]);
    expect(await store.getByThreadId("thread-1")).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
    expect(await store.getByAgentId("agent-1")).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
    expect(await store.getByAuthToken("token-1")).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });

    await store.set({
      threadId: "thread-1",
      agentId: "agent-2",
      authToken: "token-2",
    });

    expect(await store.getByAgentId("agent-1")).toBeNull();
    expect(await store.getByAuthToken("token-1")).toBeNull();
    expect(await store.getByThreadId("thread-1")).toEqual({
      threadId: "thread-1",
      agentId: "agent-2",
      authToken: "token-2",
    });

    expect(await store.deleteByThreadId("thread-1")).toEqual({
      threadId: "thread-1",
      agentId: "agent-2",
      authToken: "token-2",
    });
    expect(await store.list()).toEqual([]);

    await store.set({
      threadId: "thread-2",
      agentId: "agent-3",
      authToken: "token-3",
    });
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it("persists bindings across PGlite-backed store instances", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "flamecast-chat-sdk-"));
    cleanups.push(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    const firstStore = await SqlThreadAgentBindingStore.create({
      pgliteDataDir: dataDir,
    });
    await firstStore.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
    await firstStore.close();

    const secondStore = await SqlThreadAgentBindingStore.create({
      pgliteDataDir: dataDir,
    });
    cleanups.push(async () => {
      await secondStore.close().catch(() => undefined);
    });

    await expect(secondStore.getByThreadId("thread-1")).resolves.toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
  });

  it("defaults its PGlite directory under the current working directory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "flamecast-chat-sdk-cwd-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    cleanups.push(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    const store = await SqlThreadAgentBindingStore.create();
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
    });

    await store.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });

    await expect(store.getByThreadId("thread-1")).resolves.toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
  });

  it("accepts provided drizzle databases without taking ownership of their lifecycle", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "flamecast-chat-sdk-db-"));
    const client = await PGlite.create(dataDir);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    });

    const database = drizzlePgLite({ client });
    const store = await SqlThreadAgentBindingStore.create({
      database: {
        async execute(statement) {
          const result = await database.execute(statement);
          return result.rows;
        },
      },
    });

    await store.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
    await expect(store.getByAgentId("agent-1")).resolves.toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });

    await store.close();
    await expect(database.execute(sql`select 1 as ok`)).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  });

  it("rejects malformed SQL rows", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce([{ thread_id: 1, agent_id: "agent-1", auth_token: "token-1" }]);
    const database = {
      execute,
    };
    const store = await SqlThreadAgentBindingStore.create({ database });

    await expect(store.getByThreadId("thread-1")).rejects.toThrow(
      "Expected thread_id to be a string",
    );
  });
});

describe("extractMessageText", () => {
  it("extracts text from direct text, content, and parts", () => {
    expect(extractMessageText({ text: " hello " })).toBe("hello");
    expect(extractMessageText({ content: " world " })).toBe("world");
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
    expect(
      extractMessageText({
        parts: [{ type: "text", text: "   " }, { type: "text" }],
      }),
    ).toBeNull();
  });
});

describe("createFlamecastAgentClient", () => {
  it("re-exports the plugin entrypoint surface", () => {
    expect(pluginEntry.ChatSdkConnector).toBe(ChatSdkConnector);
    expect(pluginEntry.createFlamecastAgentClient).toBe(createFlamecastAgentClient);
    expect(pluginEntry.extractMessageText).toBe(extractMessageText);
    expect(pluginEntry.SqlThreadAgentBindingStore).toBe(SqlThreadAgentBindingStore);
  });

  it("creates agents, prompts agents, and terminates agents", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      requests.push({ method: request.method, url: request.url });
      const index = requests.length;

      if (index === 1) {
        return new Response(
          JSON.stringify({
            id: "agent-1",
            agentName: "Agent",
            spawn: { command: "node", args: ["agent.js"] },
            startedAt: "2026-03-23T00:00:00.000Z",
            lastUpdatedAt: "2026-03-23T00:00:00.000Z",
            status: "active",
            logs: [],
            pendingPermission: null,
            promptQueue: null,
            fileSystem: null,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (index === 2) {
        return new Response(JSON.stringify({ stopReason: "end_turn" }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(null, { status: 200 });
    });
    const client = createFlamecastAgentClient({
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
    });
    expect(await client.promptAgent("agent-1", "hello")).toEqual({
      stopReason: "end_turn",
    });
    await client.terminateAgent("agent-1");

    expect(requests).toEqual([
      { method: "POST", url: "http://flamecast.test/api/agents" },
      { method: "POST", url: "http://flamecast.test/api/agents/agent-1/prompt" },
      { method: "DELETE", url: "http://flamecast.test/api/agents/agent-1" },
    ]);
  });

  it("surfaces the shared client error messages and supports the global fetch fallback", async () => {
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
    const client = createFlamecastAgentClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    await expect(
      client.createAgent({
        spawn: { command: "node" },
        cwd: "/workspace",
      }),
    ).rejects.toThrow("Failed to create session");
    await expect(client.terminateAgent("agent-1")).rejects.toThrow("Failed to terminate session");

    const globalFetch = vi.fn<typeof fetch>();
    globalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    globalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ stopReason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", globalFetch);

    const fallbackClient = createFlamecastAgentClient({
      baseUrl: "http://flamecast.test/api/",
    });
    const alreadyApiClient = createFlamecastAgentClient({
      baseUrl: "http://flamecast.test/api",
    });

    expect(await fallbackClient.promptAgent("agent 1", "hello")).toEqual({
      stopReason: "end_turn",
    });
    expect(await alreadyApiClient.promptAgent("agent 2", "hello again")).toEqual({
      stopReason: "end_turn",
    });

    const firstRequest = globalFetch.mock.calls[0]?.[0];
    const secondRequest = globalFetch.mock.calls[1]?.[0];
    const firstNormalized =
      firstRequest instanceof Request ? firstRequest.url : String(firstRequest);
    const secondNormalized =
      secondRequest instanceof Request ? secondRequest.url : String(secondRequest);
    expect(decodeURIComponent(firstNormalized)).toBe(
      "http://flamecast.test/api/agents/agent 1/prompt",
    );
    expect(decodeURIComponent(secondNormalized)).toBe(
      "http://flamecast.test/api/agents/agent 2/prompt",
    );
    expect(createConnectorMcpServer("https://connector.test/mcp", "secret")).toEqual({
      type: "http",
      name: "chat-sdk",
      url: "https://connector.test/mcp",
      headers: [{ name: "x-flamecast-chat-token", value: "secret" }],
    });
  });

  it("builds connector MCP server configs", () => {
    expect(
      createConnectorMcpServer("https://connector.test/mcp", "secret", {
        headerName: "x-custom-token",
        serverName: "chat-tools",
      }),
    ).toEqual({
      type: "http",
      name: "chat-tools",
      url: "https://connector.test/mcp",
      headers: [{ name: "x-custom-token", value: "secret" }],
    });
  });

  it("passes template-based agent creation through without synthesizing spawn args", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      requests.push(request);
      return new Response(
        JSON.stringify({
          id: "agent-template",
          agentName: "Template agent",
          spawn: { command: "node", args: [] },
          startedAt: "2026-03-23T00:00:00.000Z",
          lastUpdatedAt: "2026-03-23T00:00:00.000Z",
          status: "active",
          logs: [],
          pendingPermission: null,
          promptQueue: null,
          fileSystem: null,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    const client = createFlamecastAgentClient({
      baseUrl: "http://flamecast.test",
      fetch: fetchImpl,
    });

    await expect(client.createAgent({ agentTemplateId: "codex" })).resolves.toEqual({
      id: "agent-template",
    });

    expect(requests).toHaveLength(1);
    await expect(requests[0]?.json()).resolves.toEqual({ agentTemplateId: "codex" });
  });
});

describe("ChatSdkConnector", () => {
  it("creates agents on first mention, reuses them for follow-ups, and ignores empty messages", async () => {
    const bindings = await createBindingsStore();
    const chat = createChatStub();
    const flamecast = createFlamecastStub();
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      flamecast,
      bindings,
      agent: {
        spawn: { command: "node", args: ["agent.js"] },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    connector.start();
    connector.start();

    const firstThread = createThread("thread-1");
    await chat.emitMention(firstThread, { text: "hello" });

    expect(firstThread.subscribe).toHaveBeenCalledTimes(1);
    expect(flamecast.createAgent).toHaveBeenCalledTimes(1);
    expect(flamecast.createAgent).toHaveBeenCalledWith({
      spawn: { command: "node", args: ["agent.js"] },
      cwd: "/workspace",
      mcpServers: [
        expect.objectContaining({
          type: "http",
          name: "chat-sdk",
          url: "http://connector.test/mcp",
          headers: [expect.objectContaining({ name: "x-flamecast-chat-token" })],
        }),
      ],
    });
    expect(flamecast.promptAgent).toHaveBeenCalledWith("agent-1", "hello");
    expect(await bindings.getByThreadId("thread-1")).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: expect.any(String),
    });

    await chat.emitSubscribed(firstThread, { text: "same-thread" });

    const refreshedThread = createThread("thread-1");
    await chat.emitSubscribed(refreshedThread, { content: "follow-up" });
    await chat.emitSubscribed(refreshedThread, { content: { type: "json" } });

    expect(flamecast.createAgent).toHaveBeenCalledTimes(1);
    expect(flamecast.promptAgent).toHaveBeenNthCalledWith(2, "agent-1", "same-thread");
    expect(flamecast.promptAgent).toHaveBeenNthCalledWith(3, "agent-1", "follow-up");

    const binding = await bindings.getByThreadId("thread-1");
    if (!binding) {
      throw new Error("Expected binding to exist");
    }

    const { client, transport } = await connectMcp(connector, binding.authToken);
    await client.callTool({
      name: "reply",
      arguments: { text: "hello from MCP" },
    });

    expect(firstThread.post).not.toHaveBeenCalled();
    expect(refreshedThread.post).toHaveBeenCalledWith("hello from MCP");
    await transport.close();
  });

  it("stops cleanly and continues cleanup when one agent termination fails", async () => {
    const bindings = await createBindingsStore();
    const chat = createChatStub();
    const flamecast = createFlamecastStub();
    flamecast.terminateAgent.mockRejectedValueOnce(new Error("boom"));
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      flamecast,
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    connector.start();
    await chat.emitMention(createThread("thread-1"), { text: "one" });
    await chat.emitMention(createThread("thread-2"), { text: "two" });

    await connector.stop();
    await chat.emitMention(createThread("thread-3"), { text: "ignored" });

    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-1");
    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-2");
    expect(await bindings.list()).toEqual([]);
    expect(flamecast.createAgent).toHaveBeenCalledTimes(2);
  });

  it("serves health and webhook routes", async () => {
    const bindings = await createBindingsStore();
    await bindings.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
    const chat = createChatStub();
    const connector = new ChatSdkConnector({
      chat: chat.chat,
      flamecast: createFlamecastStub(),
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
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

  it("rejects MCP requests without a valid auth token", async () => {
    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast: createFlamecastStub(),
      bindings: await createBindingsStore(),
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    const missing = await connector.fetch(
      new Request("http://connector.test/mcp", {
        method: "POST",
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Missing MCP auth token" });

    const unknown = await connector.fetch(
      new Request("http://connector.test/mcp", {
        method: "POST",
        headers: { "x-flamecast-chat-token": "missing" },
      }),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "Unknown MCP auth token" });
  });

  it("rejects MCP requests when the binding exists but the thread is not active", async () => {
    const bindings = await createBindingsStore();
    await bindings.set({
      threadId: "thread-1",
      agentId: "agent-1",
      authToken: "token-1",
    });
    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast: createFlamecastStub(),
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    const response = await connector.fetch(
      new Request("http://connector.test/mcp", {
        method: "POST",
        headers: { "x-flamecast-chat-token": "token-1" },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Thread is not active in this connector process",
    });
  });

  it("routes MCP reply, typing, subscribe, and unsubscribe tools to the bound thread", async () => {
    const bindings = await createBindingsStore();
    const flamecast = createFlamecastStub();
    const subscribedThread = createThread("thread-1");
    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast,
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    connector.start();
    await connector.handleNewMention(subscribedThread, { text: "hello" });
    const binding = await bindings.getByThreadId("thread-1");
    if (!binding) {
      throw new Error("Expected binding to exist");
    }

    const { client, transport } = await connectMcp(connector, binding.authToken);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "reply",
      "subscribe",
      "typing.start",
      "unsubscribe",
    ]);

    await client.callTool({
      name: "reply",
      arguments: { text: "hello from MCP" },
    });
    await client.callTool({
      name: "typing.start",
      arguments: {},
    });
    await client.callTool({
      name: "subscribe",
      arguments: {},
    });
    await client.callTool({
      name: "unsubscribe",
      arguments: {},
    });

    expect(subscribedThread.post).toHaveBeenCalledWith("hello from MCP");
    expect(subscribedThread.startTyping).toHaveBeenCalledTimes(1);
    expect(subscribedThread.subscribe).toHaveBeenCalledTimes(2);
    expect(subscribedThread.unsubscribe).toHaveBeenCalledTimes(1);
    expect(flamecast.terminateAgent).toHaveBeenCalledWith("agent-1");
    expect(await bindings.getByThreadId("thread-1")).toBeNull();

    await transport.close();
  });

  it("treats missing typing support as a no-op", async () => {
    const bindings = await createBindingsStore();
    const thread = createThread("thread-1", {
      startTyping: undefined,
    });
    const connector = new ChatSdkConnector({
      chat: createChatStub().chat,
      flamecast: createFlamecastStub(),
      bindings,
      agent: {
        spawn: { command: "node" },
        cwd: "/workspace",
      },
      mcpEndpoint: "http://connector.test/mcp",
    });

    connector.start();
    await connector.handleNewMention(thread, { text: "hello" });
    const binding = await bindings.getByThreadId("thread-1");
    if (!binding) {
      throw new Error("Expected binding to exist");
    }

    const { client, transport } = await connectMcp(connector, binding.authToken);
    await expect(
      client.callTool({
        name: "typing.start",
        arguments: {},
      }),
    ).resolves.toBeTruthy();
    await transport.close();
  });
});
