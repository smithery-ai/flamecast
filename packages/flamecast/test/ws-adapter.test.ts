/**
 * Integration tests for the WS adapter (multiplexed WebSocket endpoint).
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { EventBus } from "../src/flamecast/events/bus.js";
import { WsAdapter, type WsAdapterFlamecast } from "../src/node/ws-adapter.js";
import type { WsChannelServerMessage } from "@flamecast/protocol/ws/channels";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitFor(ws: WebSocket): Promise<WsChannelServerMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timed out")), 3000);
    ws.once("message", (d) => {
      clearTimeout(t);
      resolve(JSON.parse(String(d)));
    });
  });
}

function collect(ws: WebSocket, n: number): Promise<WsChannelServerMessage[]> {
  return new Promise((resolve, reject) => {
    const msgs: WsChannelServerMessage[] = [];
    const t = setTimeout(() => reject(new Error(`Got ${msgs.length}/${n}`)), 3000);
    const fn = (d: WebSocket.RawData) => {
      msgs.push(JSON.parse(String(d)));
      if (msgs.length >= n) {
        clearTimeout(t);
        ws.off("message", fn);
        resolve(msgs);
      }
    };
    ws.on("message", fn);
  });
}

const noop: WsAdapterFlamecast = {
  async promptSession() {
    return {};
  },
  async terminateSession() {},
  async resolvePermission() {
    return {};
  },
  async proxyQueueRequest() {
    return new Response("ok");
  },
};

async function setup(opts?: { maxSubscriptionsPerConnection?: number }) {
  const eventBus = new EventBus();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const adapter = new WsAdapter({ server, eventBus, flamecast: noop, ...opts });
  const clients: WebSocket[] = [];

  const connect = async (): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    clients.push(ws);
    // Wait for the "connected" message (the first message after handshake)
    const msg = await waitFor(ws);
    expect(msg.type).toBe("connected");
    return ws;
  };

  const teardown = async () => {
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.close();
    adapter.close();
    await new Promise<void>((r) => server.close(() => r()));
  };

  return { eventBus, adapter, connect, teardown, port, clients };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WsAdapter", () => {
  it("sends connected message", async () => {
    const t = await setup();
    const ws = new WebSocket(`ws://localhost:${t.port}/ws`);
    t.clients.push(ws);
    const msg = await waitFor(ws);
    expect(msg.type).toBe("connected");
    expect(msg).toHaveProperty("connectionId");
    await t.teardown();
  });

  it("subscribe / unsubscribe", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    expect(await waitFor(ws)).toEqual({ type: "subscribed", channel: "session:s1" });
    ws.send(JSON.stringify({ action: "unsubscribe", channel: "session:s1" }));
    expect(await waitFor(ws)).toEqual({ type: "unsubscribed", channel: "session:s1" });
    await t.teardown();
  });

  it("routes events to subscribed clients", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    await waitFor(ws);

    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: { method: "session.update" }, timestamp: "t1" },
    });
    const msg = await waitFor(ws);
    expect(msg.type).toBe("event");
    if (msg.type === "event") {
      expect(msg.channel).toBe("session:s1");
      expect(msg.seq).toBe(1);
    }
    await t.teardown();
  });

  it("does not deliver after unsubscribe", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    await waitFor(ws);
    ws.send(JSON.stringify({ action: "unsubscribe", channel: "session:s1" }));
    await waitFor(ws);

    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: {}, timestamp: "t1" },
    });
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s2" }));
    const msg = await waitFor(ws);
    expect(msg.type).toBe("subscribed");
    await t.teardown();
  });

  it("deduplicates overlapping subscriptions", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "agent:s1" }));
    await waitFor(ws);
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    await waitFor(ws);

    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: {}, timestamp: "t1" },
    });
    const msg = await waitFor(ws);
    expect(msg.type).toBe("event");
    if (msg.type === "event") expect(msg.channel).toBe("session:s1");

    // No duplicate
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s2" }));
    expect((await waitFor(ws)).type).toBe("subscribed");
    await t.teardown();
  });

  it("tags with most specific sub-channel", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1:queue" }));
    await waitFor(ws);

    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "queue.updated", data: {}, timestamp: "t1" },
    });
    const msg = await waitFor(ws);
    if (msg.type === "event") expect(msg.channel).toBe("session:s1:queue");
    await t.teardown();
  });

  it("replays history on subscribe", async () => {
    const t = await setup();
    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: { n: 1 }, timestamp: "t1" },
    });
    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: { n: 2 }, timestamp: "t2" },
    });

    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    const msgs = await collect(ws, 3);
    expect(msgs[0].type).toBe("event");
    expect(msgs[1].type).toBe("event");
    expect(msgs[2].type).toBe("subscribed");
    await t.teardown();
  });

  it("replays only events after since", async () => {
    const t = await setup();
    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: {}, timestamp: "t1" },
    });
    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: {}, timestamp: "t2" },
    });
    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: {}, timestamp: "t3" },
    });

    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1", since: 2 }));
    const msgs = await collect(ws, 2);
    expect(msgs[0].type).toBe("event");
    if (msgs[0].type === "event") expect(msgs[0].seq).toBe(3);
    expect(msgs[1].type).toBe("subscribed");
    await t.teardown();
  });

  it("enforces max subscriptions", async () => {
    const t = await setup({ maxSubscriptionsPerConnection: 2 });
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    await waitFor(ws);
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s2" }));
    await waitFor(ws);
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s3" }));
    const msg = await waitFor(ws);
    expect(msg.type).toBe("error");
    if (msg.type === "error") expect(msg.message).toContain("Max subscriptions");
    await t.teardown();
  });

  it("allows idempotent re-subscribe within limit", async () => {
    const t = await setup({ maxSubscriptionsPerConnection: 2 });
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    await waitFor(ws);
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s2" }));
    await waitFor(ws);
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    const msg = await waitFor(ws);
    expect(msg.type).toBe("subscribed");
    await t.teardown();
  });

  it("broadcasts session.created to agents channel", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "agents" }));
    await waitFor(ws);
    t.eventBus.emitSessionCreated({ sessionId: "s1", agentId: "s1", websocketUrl: "ws://x" });
    expect(await waitFor(ws)).toEqual({ type: "session.created", sessionId: "s1", agentId: "s1" });
    await t.teardown();
  });

  it("broadcasts session.terminated to agents channel", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "agents" }));
    await waitFor(ws);
    t.eventBus.emitSessionTerminated({ sessionId: "s1", agentId: "s1" });
    expect(await waitFor(ws)).toEqual({
      type: "session.terminated",
      sessionId: "s1",
      agentId: "s1",
    });
    await t.teardown();
  });

  it("sends error for invalid JSON", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send("not json");
    const msg = await waitFor(ws);
    expect(msg.type).toBe("error");
    await t.teardown();
  });

  it("handles client disconnect gracefully", async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send(JSON.stringify({ action: "subscribe", channel: "session:s1" }));
    await waitFor(ws);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    // Should not throw
    t.eventBus.pushEvent({
      sessionId: "s1",
      agentId: "s1",
      event: { type: "rpc", data: {}, timestamp: "t1" },
    });
    await t.teardown();
  });
});
