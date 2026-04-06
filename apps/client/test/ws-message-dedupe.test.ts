import { describe, expect, it } from "vitest";
import { createWsMessageDedupeState, rememberWsMessage } from "@flamecast/ui";

describe("rememberWsMessage", () => {
  it("drops duplicate replayed websocket messages", () => {
    const state = createWsMessageDedupeState();

    expect(rememberWsMessage(state, '{"type":"event","timestamp":"1"}')).toBe(true);
    expect(rememberWsMessage(state, '{"type":"event","timestamp":"1"}')).toBe(false);
  });

  it("forgets the oldest message once the buffer reaches capacity", () => {
    const state = createWsMessageDedupeState();

    expect(rememberWsMessage(state, "a", 2)).toBe(true);
    expect(rememberWsMessage(state, "b", 2)).toBe(true);
    expect(rememberWsMessage(state, "c", 2)).toBe(true);
    expect(rememberWsMessage(state, "a", 2)).toBe(true);
  });
});
