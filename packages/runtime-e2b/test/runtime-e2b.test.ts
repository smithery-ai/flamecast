import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxCommandsRun =
  vi.fn<
    (
      command: string,
      opts?: { timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  >();
const sandboxFilesList = vi.fn();
const sandboxFilesRead = vi.fn();
const sandboxFilesGetInfo = vi.fn();
const sandboxList = vi.fn();
const sandboxConnect = vi.fn();
const sandboxGetFullInfo = vi.fn();
const sandboxCreate = vi.fn();
const sandboxKill = vi.fn();
const sandboxPause = vi.fn();

class MockSandbox {
  readonly sandboxId: string;
  readonly commands = {
    run: sandboxCommandsRun,
  };
  readonly files = {
    list: sandboxFilesList,
    read: sandboxFilesRead,
    getInfo: sandboxFilesGetInfo,
    write: vi.fn(async () => undefined),
  };

  constructor(sandboxId: string) {
    this.sandboxId = sandboxId;
  }

  getHost(port: number) {
    return `${this.sandboxId}-${port}.example.test`;
  }

  static list(...args: unknown[]) {
    return sandboxList(...args);
  }

  static connect(...args: unknown[]) {
    return sandboxConnect(...args);
  }

  static getFullInfo(...args: unknown[]) {
    return sandboxGetFullInfo(...args);
  }

  static create(...args: unknown[]) {
    return sandboxCreate(...args);
  }

  static kill(...args: unknown[]) {
    return sandboxKill(...args);
  }

  static pause(...args: unknown[]) {
    return sandboxPause(...args);
  }
}

vi.mock("e2b/dist/index.mjs", () => ({
  Sandbox: MockSandbox,
}));

const { E2BRuntime } = await import("../src/index.js");

afterEach(() => {
  sandboxCommandsRun.mockReset();
  sandboxFilesList.mockReset();
  sandboxFilesRead.mockReset();
  sandboxFilesGetInfo.mockReset();
  sandboxList.mockReset();
  sandboxConnect.mockReset();
  sandboxGetFullInfo.mockReset();
  sandboxCreate.mockReset();
  sandboxKill.mockReset();
  sandboxPause.mockReset();
});

describe("E2BRuntime", () => {
  it("resolves runtime status directly from sandbox metadata", async () => {
    sandboxList.mockReturnValue({
      hasNext: true,
      nextItems: async () => [
        {
          sandboxId: "sandbox-1",
          metadata: { "flamecast.instance": "runtime-1" },
          state: "running",
        },
      ],
    });

    const runtime = new E2BRuntime({ apiKey: "test-key" });

    await expect(runtime.getInstanceStatus("runtime-1")).resolves.toBe("running");
    expect(sandboxList).toHaveBeenCalledWith({
      apiKey: "test-key",
      limit: 1,
      query: {
        metadata: { "flamecast.instance": "runtime-1" },
      },
    });
  });

  it("returns a filesystem snapshot for a metadata-matched sandbox", async () => {
    sandboxList.mockReturnValue({
      hasNext: true,
      nextItems: async () => [
        {
          sandboxId: "sandbox-1",
          metadata: { "flamecast.instance": "runtime-1" },
          state: "running",
        },
      ],
    });
    sandboxConnect.mockResolvedValue(new MockSandbox("sandbox-1"));
    sandboxFilesList.mockResolvedValue([
      {
        path: "/home/user/src",
        type: "dir",
      },
      {
        path: "/home/user/src/index.ts",
        type: "file",
      },
    ]);
    sandboxFilesRead.mockResolvedValue("");

    const runtime = new E2BRuntime({ apiKey: "test-key" });
    const response = await runtime.fetchInstance(
      "runtime-1",
      new Request("http://host/fs/snapshot?showAllFiles=true", { method: "GET" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      root: "/home/user",
      entries: [
        { path: "src", type: "directory" },
        { path: "src/index.ts", type: "file" },
      ],
      truncated: false,
      maxEntries: 10_000,
    });
  });
});
