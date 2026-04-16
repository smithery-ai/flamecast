import { describe, expect, it } from "vitest";
import { formatTerminalSnapshot } from "./terminal-stream";

describe("formatTerminalSnapshot", () => {
  it("converts LF-delimited pane snapshots to CRLF for terminal replay", () => {
    expect(formatTerminalSnapshot("alpha\nbeta\n")).toBe("alpha\r\nbeta\r\n");
  });

  it("preserves existing CRLF sequences without doubling carriage returns", () => {
    expect(formatTerminalSnapshot("alpha\r\nbeta\r\n")).toBe("alpha\r\nbeta\r\n");
  });
});
