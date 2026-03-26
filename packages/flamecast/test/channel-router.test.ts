import { describe, it, expect } from "vitest";
import {
  eventToChannels,
  resolveAgentId,
  isTerminalChannelEvent,
  isQueueChannelEvent,
  isFsChannelEvent,
  type ChannelEvent,
} from "../src/flamecast/channel-router.js";

function makeEvent(
  overrides: Partial<ChannelEvent> & { event: ChannelEvent["event"] },
): ChannelEvent {
  return {
    sessionId: "sess-1",
    agentId: "sess-1",
    seq: 1,
    ...overrides,
  };
}

describe("resolveAgentId", () => {
  it("returns sessionId in 1:1 model", () => {
    expect(resolveAgentId("abc-123")).toBe("abc-123");
  });
});

describe("eventToChannels", () => {
  it("routes a generic rpc event to session + agent + agents", () => {
    const event = makeEvent({
      event: { type: "rpc", data: { method: "session.update" }, timestamp: "" },
    });
    const channels = eventToChannels(event);
    expect(channels).toEqual(["session:sess-1", "agent:sess-1", "agents"]);
  });

  it("routes a terminal rpc event to terminal sub-channels", () => {
    const event = makeEvent({
      event: {
        type: "rpc",
        data: { method: "terminal.output", terminalId: "term-1" },
        timestamp: "",
      },
    });
    const channels = eventToChannels(event);
    expect(channels).toEqual([
      "session:sess-1:terminal:term-1",
      "session:sess-1:terminal",
      "session:sess-1",
      "agent:sess-1",
      "agents",
    ]);
  });

  it("routes a terminal event without terminalId", () => {
    const event = makeEvent({
      event: {
        type: "rpc",
        data: { method: "terminal.create" },
        timestamp: "",
      },
    });
    const channels = eventToChannels(event);
    expect(channels).toContain("session:sess-1:terminal");
    expect(channels).not.toContain(expect.stringContaining(":terminal:"));
  });

  it("routes a direct terminal event type", () => {
    const event = makeEvent({
      event: { type: "terminal.output", data: {}, timestamp: "" },
    });
    expect(eventToChannels(event)).toContain("session:sess-1:terminal");
  });

  it("routes queue events to queue sub-channel", () => {
    const event = makeEvent({
      event: { type: "queue.updated", data: {}, timestamp: "" },
    });
    const channels = eventToChannels(event);
    expect(channels).toContain("session:sess-1:queue");
    expect(channels).toContain("session:sess-1");
    expect(channels).toContain("agent:sess-1");
  });

  it("routes queue.paused and queue.resumed", () => {
    for (const type of ["queue.paused", "queue.resumed"]) {
      const event = makeEvent({ event: { type, data: {}, timestamp: "" } });
      expect(eventToChannels(event)).toContain("session:sess-1:queue");
    }
  });

  it("routes filesystem events to fs sub-channels", () => {
    const event = makeEvent({
      agentId: "agent-A",
      event: { type: "filesystem.changed", data: {}, timestamp: "" },
    });
    const channels = eventToChannels(event);
    expect(channels).toContain("session:sess-1:fs");
    expect(channels).toContain("agent:agent-A:fs");
    expect(channels).toContain("session:sess-1");
    expect(channels).toContain("agent:agent-A");
  });

  it("routes file.preview to fs sub-channel", () => {
    const event = makeEvent({
      event: { type: "file.preview", data: {}, timestamp: "" },
    });
    expect(eventToChannels(event)).toContain("session:sess-1:fs");
  });

  it("routes unknown event types to session + agent only", () => {
    const event = makeEvent({
      event: { type: "some_unknown_event", data: {}, timestamp: "" },
    });
    const channels = eventToChannels(event);
    expect(channels).toEqual(["session:sess-1", "agent:sess-1", "agents"]);
  });

  it("returns channels in specificity order (most specific first)", () => {
    const event = makeEvent({
      agentId: "agent-A",
      event: {
        type: "rpc",
        data: { method: "terminal.output", terminalId: "t1" },
        timestamp: "",
      },
    });
    const channels = eventToChannels(event);
    // Most specific first
    expect(channels.indexOf("session:sess-1:terminal:t1")).toBeLessThan(
      channels.indexOf("session:sess-1:terminal"),
    );
    expect(channels.indexOf("session:sess-1:terminal")).toBeLessThan(
      channels.indexOf("session:sess-1"),
    );
    expect(channels.indexOf("session:sess-1")).toBeLessThan(channels.indexOf("agent:agent-A"));
    expect(channels.indexOf("agent:agent-A")).toBeLessThan(channels.indexOf("agents"));
  });

  it("handles event matching multiple sub-channels (fs events go to agent:fs too)", () => {
    const event = makeEvent({
      agentId: "agent-A",
      event: { type: "filesystem.snapshot", data: {}, timestamp: "" },
    });
    const channels = eventToChannels(event);
    expect(channels).toContain("session:sess-1:fs");
    expect(channels).toContain("agent:agent-A:fs");
  });
});

describe("classification helpers", () => {
  it("isTerminalChannelEvent", () => {
    expect(
      isTerminalChannelEvent(
        makeEvent({ event: { type: "terminal.output", data: {}, timestamp: "" } }),
      ),
    ).toBe(true);
    expect(
      isTerminalChannelEvent(
        makeEvent({
          event: { type: "rpc", data: { method: "terminal.create" }, timestamp: "" },
        }),
      ),
    ).toBe(true);
    expect(
      isTerminalChannelEvent(
        makeEvent({ event: { type: "rpc", data: { method: "session.update" }, timestamp: "" } }),
      ),
    ).toBe(false);
  });

  it("isQueueChannelEvent", () => {
    expect(
      isQueueChannelEvent(makeEvent({ event: { type: "queue.updated", data: {}, timestamp: "" } })),
    ).toBe(true);
    expect(
      isQueueChannelEvent(makeEvent({ event: { type: "rpc", data: {}, timestamp: "" } })),
    ).toBe(false);
  });

  it("isFsChannelEvent", () => {
    expect(
      isFsChannelEvent(
        makeEvent({ event: { type: "filesystem.changed", data: {}, timestamp: "" } }),
      ),
    ).toBe(true);
    expect(
      isFsChannelEvent(makeEvent({ event: { type: "file.preview", data: {}, timestamp: "" } })),
    ).toBe(true);
    expect(
      isFsChannelEvent(
        makeEvent({ event: { type: "rpc", data: { method: "session.update" }, timestamp: "" } }),
      ),
    ).toBe(false);
  });
});
