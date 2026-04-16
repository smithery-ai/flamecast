import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:util")>();
  return {
    ...original,
    promisify: vi.fn(() => execMock),
  };
});

describe("tmux.newSession", () => {
  beforeEach(() => {
    execMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retries once when tmux reports a transient server startup failure", async () => {
    execMock
      .mockRejectedValueOnce(
        new Error("Command failed: tmux new-session\nserver exited unexpectedly"),
      )
      .mockResolvedValueOnce({ stderr: "", stdout: "" });

    const tmux = await import("../../src/flamecast/sessions/tmux.js");

    await expect(tmux.newSession("fc_retry_me", "/tmp", "/bin/bash")).resolves.toBeUndefined();
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(1, "tmux", [
      "new-session",
      "-d",
      "-s",
      "fc_retry_me",
      "-c",
      "/tmp",
      "/bin/bash",
    ]);
  });

  it("does not retry unrelated tmux failures", async () => {
    execMock.mockRejectedValueOnce(new Error("duplicate session: fc_exists"));

    const tmux = await import("../../src/flamecast/sessions/tmux.js");

    await expect(tmux.newSession("fc_exists", "/tmp", "/bin/bash")).rejects.toThrow(
      "duplicate session: fc_exists",
    );
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
