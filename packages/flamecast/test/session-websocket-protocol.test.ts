import { describe, expect, it } from "vitest";
import {
  detectSessionWebSocketProtocol,
  toNormalizedSessionTapEvent,
  toSessionPermissionResponseMessage,
} from "../src/flamecast/session-websocket-protocol.js";

describe("session websocket protocol helpers", () => {
  it("detects channel-based handshakes", () => {
    expect(detectSessionWebSocketProtocol({ type: "connected", connectionId: "conn-1" })).toEqual({
      kind: "channel",
    });
  });

  it("detects direct session handshakes", () => {
    expect(detectSessionWebSocketProtocol({ type: "connected", sessionId: "sess-1" })).toEqual({
      kind: "direct-session",
      sessionId: "sess-1",
    });
  });

  it("normalizes direct session events for the event tap", () => {
    expect(
      toNormalizedSessionTapEvent(
        {
          type: "event",
          event: {
            type: "rpc",
            data: { method: "session/prompt" },
            timestamp: "2026-04-09T00:00:00.000Z",
          },
        },
        "sess-1",
        { kind: "direct-session", sessionId: "sess-1" },
      ),
    ).toEqual({
      sessionId: "sess-1",
      agentId: "sess-1",
      event: {
        type: "rpc",
        data: { method: "session/prompt" },
        timestamp: "2026-04-09T00:00:00.000Z",
      },
    });
  });

  it("removes sessionId from direct session permission responses", () => {
    expect(
      toSessionPermissionResponseMessage(
        { kind: "direct-session", sessionId: "sess-1" },
        "sess-1",
        "req-1",
        { optionId: "allow" },
      ),
    ).toEqual({
      action: "permission.respond",
      requestId: "req-1",
      body: { optionId: "allow" },
    });
  });
});
