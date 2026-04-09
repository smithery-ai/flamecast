import { describe, expect, it } from "vitest";
import {
  detectSessionWebSocketProtocol,
  toNormalizedSessionLogMessage,
  toWireSessionControlMessage,
} from "../src/lib/session-websocket-protocol.js";

describe("session websocket protocol helpers", () => {
  it("detects channel-based session websocket handshakes", () => {
    expect(detectSessionWebSocketProtocol({ type: "connected", connectionId: "conn-1" })).toEqual({
      kind: "channel",
    });
  });

  it("detects direct session websocket handshakes", () => {
    expect(detectSessionWebSocketProtocol({ type: "connected", sessionId: "sess-1" })).toEqual({
      kind: "direct-session",
      sessionId: "sess-1",
    });
  });

  it("normalizes channel session events", () => {
    expect(
      toNormalizedSessionLogMessage(
        {
          type: "event",
          channel: "session:sess-1",
          seq: 3,
          event: {
            type: "rpc",
            data: { phase: "response" },
            timestamp: "2026-04-09T00:00:00.000Z",
          },
        },
        "sess-1",
        { kind: "channel" },
      ),
    ).toEqual({
      log: {
        type: "rpc",
        data: { phase: "response" },
        timestamp: "2026-04-09T00:00:00.000Z",
      },
      seq: 3,
    });
  });

  it("normalizes direct session events", () => {
    expect(
      toNormalizedSessionLogMessage(
        {
          type: "event",
          event: {
            type: "agent_message_chunk",
            data: { text: "hello" },
            timestamp: "2026-04-09T00:00:00.000Z",
          },
        },
        "sess-1",
        { kind: "direct-session", sessionId: "sess-1" },
      ),
    ).toEqual({
      log: {
        type: "agent_message_chunk",
        data: { text: "hello" },
        timestamp: "2026-04-09T00:00:00.000Z",
      },
    });
  });

  it("translates direct session prompt actions to the raw session-host protocol", () => {
    expect(
      toWireSessionControlMessage(
        { action: "prompt", sessionId: "sess-1", text: "hello" },
        { kind: "direct-session", sessionId: "sess-1" },
      ),
    ).toEqual({ action: "prompt", text: "hello" });
  });
});
