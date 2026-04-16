import { describe, expect, it, vi } from "vitest";
import { writeTerminalData } from "#/lib/terminal-stream";

describe("writeTerminalData", () => {
  it("writes string payloads directly", async () => {
    const write = vi.fn();

    await writeTerminalData({ write }, "hello");

    expect(write).toHaveBeenCalledWith("hello");
  });

  it("converts array buffers into byte arrays", async () => {
    const write = vi.fn();
    const buffer = new Uint8Array([104, 105]).buffer;

    await writeTerminalData({ write }, buffer);

    expect(write).toHaveBeenCalledWith(new Uint8Array([104, 105]));
  });

  it("converts blob payloads into byte arrays", async () => {
    const write = vi.fn();
    const blob = new Blob([new Uint8Array([104, 105])]);

    await writeTerminalData({ write }, blob);

    expect(write).toHaveBeenCalledWith(new Uint8Array([104, 105]));
  });
});
