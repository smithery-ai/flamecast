import { describe, expect, it } from "vitest";
import { trimTrailingBlankLines } from "../../src/flamecast/stream-manager.js";

describe("trimTrailingBlankLines", () => {
  it("removes the empty viewport rows from an initial pane replay", () => {
    expect(trimTrailingBlankLines("prompt\n\n\n")).toBe("prompt");
  });

  it("preserves interior blank lines", () => {
    expect(trimTrailingBlankLines("first\n\nsecond\n")).toBe("first\n\nsecond");
  });
});
