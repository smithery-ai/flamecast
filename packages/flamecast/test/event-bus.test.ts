import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/flamecast/events/bus.js";
import type { ChannelEvent } from "../src/flamecast/events/channels.js";

function makeRawEvent(
  sessionId: string,
  type: string,
  data: Record<string, unknown> = {},
): Omit<ChannelEvent, "seq"> {
  return {
    sessionId,
    agentId: sessionId,
    event: { type, data, timestamp: new Date().toISOString() },
  };
}

describe("EventBus", () => {
  describe("lifecycle events", () => {
    it("emits session.created", () => {
      const bus = new EventBus();
      const listener = vi.fn();
      bus.onSessionCreated(listener);

      const payload = { sessionId: "s1", agentId: "s1", websocketUrl: "ws://localhost:9999" };
      bus.emitSessionCreated(payload);

      expect(listener).toHaveBeenCalledWith(payload);
    });

    it("emits session.terminated and clears history", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "rpc"));

      expect(bus.getHistory("s1")).toHaveLength(1);

      const listener = vi.fn();
      bus.onSessionTerminated(listener);
      bus.emitSessionTerminated({ sessionId: "s1", agentId: "s1" });

      expect(listener).toHaveBeenCalledWith({ sessionId: "s1", agentId: "s1" });
      expect(bus.getHistory("s1")).toHaveLength(0);
    });

    it("returns unsubscribe function for lifecycle listeners", () => {
      const bus = new EventBus();
      const listener = vi.fn();
      const unsub = bus.onSessionCreated(listener);

      unsub();
      bus.emitSessionCreated({ sessionId: "s1", agentId: "s1", websocketUrl: "ws://x" });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("pushEvent + seq numbering", () => {
    it("assigns monotonic seq numbers per session", () => {
      const bus = new EventBus();
      const e1 = bus.pushEvent(makeRawEvent("s1", "rpc"));
      const e2 = bus.pushEvent(makeRawEvent("s1", "rpc"));
      const e3 = bus.pushEvent(makeRawEvent("s2", "rpc"));

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(1); // separate session counter
    });

    it("emits events to listeners", () => {
      const bus = new EventBus();
      const listener = vi.fn();
      bus.onEvent(listener);

      const event = bus.pushEvent(makeRawEvent("s1", "rpc"));

      expect(listener).toHaveBeenCalledWith(event);
    });

    it("returns unsubscribe function for event listeners", () => {
      const bus = new EventBus();
      const listener = vi.fn();
      const unsub = bus.onEvent(listener);

      unsub();
      bus.pushEvent(makeRawEvent("s1", "rpc"));

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("history", () => {
    it("stores events in history buffer", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "rpc"));
      bus.pushEvent(makeRawEvent("s1", "queue.updated"));
      bus.pushEvent(makeRawEvent("s2", "rpc"));

      expect(bus.getHistory("s1")).toHaveLength(2);
      expect(bus.getHistory("s2")).toHaveLength(1);
      expect(bus.getHistory("s3")).toHaveLength(0);
    });

    it("filters history with since parameter", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "rpc")); // seq 1
      bus.pushEvent(makeRawEvent("s1", "rpc")); // seq 2
      bus.pushEvent(makeRawEvent("s1", "rpc")); // seq 3

      const since2 = bus.getHistory("s1", { since: 2 });
      expect(since2).toHaveLength(1);
      expect(since2[0]?.seq).toBe(3);
    });

    it("filters history with custom filter", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "rpc"));
      bus.pushEvent(makeRawEvent("s1", "queue.updated"));
      bus.pushEvent(makeRawEvent("s1", "rpc"));

      const queueOnly = bus.getHistory("s1", {
        filter: (e) => e.event.type === "queue.updated",
      });
      expect(queueOnly).toHaveLength(1);
      expect(queueOnly[0]?.event.type).toBe("queue.updated");
    });

    it("combines since and filter", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "queue.updated")); // seq 1
      bus.pushEvent(makeRawEvent("s1", "rpc")); // seq 2
      bus.pushEvent(makeRawEvent("s1", "queue.updated")); // seq 3

      const result = bus.getHistory("s1", {
        since: 1,
        filter: (e) => e.event.type === "queue.updated",
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.seq).toBe(3);
    });

    it("getLastEvent returns most recent matching event", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "queue.updated"));
      bus.pushEvent(makeRawEvent("s1", "rpc"));
      bus.pushEvent(makeRawEvent("s1", "queue.updated"));

      const last = bus.getLastEvent("s1", (e) => e.event.type === "queue.updated");
      expect(last).toBeDefined();
      expect(last?.seq).toBe(3);
    });

    it("getLastEvent returns undefined when no match", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "rpc"));

      expect(bus.getLastEvent("s1", (e) => e.event.type === "queue.updated")).toBeUndefined();
    });

    it("getLastEvent returns undefined for unknown session", () => {
      const bus = new EventBus();
      expect(bus.getLastEvent("unknown", () => true)).toBeUndefined();
    });

    it("clearHistory removes all events and resets seq counter", () => {
      const bus = new EventBus();
      bus.pushEvent(makeRawEvent("s1", "rpc")); // seq 1
      bus.clearHistory("s1");

      expect(bus.getHistory("s1")).toHaveLength(0);

      // Seq counter resets
      const e = bus.pushEvent(makeRawEvent("s1", "rpc"));
      expect(e.seq).toBe(1);
    });
  });

  describe("history caps", () => {
    it("enforces default cap", () => {
      const bus = new EventBus({ historyCaps: { default: 5 } });
      for (let i = 0; i < 10; i++) {
        bus.pushEvent(makeRawEvent("s1", "some_event"));
      }
      const history = bus.getHistory("s1");
      expect(history).toHaveLength(5);
      // Should keep the most recent events
      expect(history[0]?.seq).toBe(6);
      expect(history[4]?.seq).toBe(10);
    });

    it("enforces terminal cap separately", () => {
      const bus = new EventBus({ historyCaps: { terminal: 3, default: 100 } });
      for (let i = 0; i < 10; i++) {
        bus.pushEvent(makeRawEvent("s1", "terminal.output"));
      }
      // Only terminal events are capped at 3; other categories unaffected
      const history = bus.getHistory("s1");
      expect(history).toHaveLength(3);
    });

    it("does not evict events from other categories", () => {
      const bus = new EventBus({ historyCaps: { rpc: 100, snapshot: 2 } });
      // Push 50 RPC events
      for (let i = 0; i < 50; i++) {
        bus.pushEvent(makeRawEvent("s1", "rpc"));
      }
      // Push 5 queue events (snapshot category, cap 2)
      for (let i = 0; i < 5; i++) {
        bus.pushEvent(makeRawEvent("s1", "queue.updated"));
      }
      const history = bus.getHistory("s1");
      // Should have 50 RPC + 2 queue = 52 total
      const rpcCount = history.filter((e) => e.event.type === "rpc").length;
      const queueCount = history.filter((e) => e.event.type === "queue.updated").length;
      expect(rpcCount).toBe(50);
      expect(queueCount).toBe(2);
    });

    it("enforces rpc cap", () => {
      const bus = new EventBus({ historyCaps: { rpc: 2 } });
      for (let i = 0; i < 5; i++) {
        bus.pushEvent(makeRawEvent("s1", "rpc"));
      }
      expect(bus.getHistory("s1")).toHaveLength(2);
    });

    it("enforces snapshot cap for queue events", () => {
      const bus = new EventBus({ historyCaps: { snapshot: 2 } });
      for (let i = 0; i < 5; i++) {
        bus.pushEvent(makeRawEvent("s1", "queue.updated"));
      }
      expect(bus.getHistory("s1")).toHaveLength(2);
    });

    it("enforces snapshot cap for filesystem events", () => {
      const bus = new EventBus({ historyCaps: { snapshot: 2 } });
      for (let i = 0; i < 5; i++) {
        bus.pushEvent(makeRawEvent("s1", "filesystem.changed"));
      }
      expect(bus.getHistory("s1")).toHaveLength(2);
    });
  });
});
