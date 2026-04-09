import { describe, expect, it } from "vitest";
import {
  detectRuntimeWebSocketProtocol,
  getRuntimeWebSocketChannel,
  toWireControlMessage,
} from "../src/lib/runtime-websocket-protocol.js";

describe("runtime websocket protocol helpers", () => {
  it("detects channel-based websocket handshakes", () => {
    expect(detectRuntimeWebSocketProtocol({ type: "connected", connectionId: "conn-1" })).toEqual({
      kind: "channel",
    });
  });

  it("detects direct session websocket handshakes", () => {
    expect(detectRuntimeWebSocketProtocol({ type: "connected", sessionId: "sess-1" })).toEqual({
      kind: "direct-session",
      sessionId: "sess-1",
    });
  });

  it("routes direct session events to the session channel", () => {
    expect(
      getRuntimeWebSocketChannel(
        { type: "event", event: { type: "rpc", data: {}, timestamp: "2026-04-09T00:00:00.000Z" } },
        { kind: "direct-session", sessionId: "sess-1" },
      ),
    ).toBe("session:sess-1");
  });

  it("drops subscribe actions for direct session websockets", () => {
    expect(
      toWireControlMessage(
        { action: "subscribe", channel: "session:sess-1" },
        { kind: "direct-session", sessionId: "sess-1" },
      ),
    ).toBeNull();
  });

  it("translates direct session prompt actions to the raw session-host protocol", () => {
    expect(
      toWireControlMessage(
        { action: "prompt", sessionId: "sess-1", text: "hello" },
        { kind: "direct-session", sessionId: "sess-1" },
      ),
    ).toEqual({ action: "prompt", text: "hello" });
  });
});
