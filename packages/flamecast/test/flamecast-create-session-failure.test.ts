import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("flamecast createSession failure cleanup", () => {
  test("terminates the started runtime when ACP initialization fails", async () => {
    const terminate = vi.fn(async () => {});

    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );

      class FailingClientSideConnection {
        constructor(_factory: unknown, _stream: unknown) {}

        async initialize() {
          throw new Error("initialize failed");
        }
      }

      return {
        ...actual,
        ndJsonStream: vi.fn(() => ({ kind: "stream" })),
        ClientSideConnection: FailingClientSideConnection,
      };
    });

    const { Flamecast } = await import("../src/flamecast/index.js?create-session-failure");

    const flamecast = new Flamecast({
      storage: "memory",
      runtimeProviders: {
        local: {
          start: vi.fn(async () => ({
            transport: {
              input: new WritableStream<Uint8Array>(),
              output: new ReadableStream<Uint8Array>(),
            },
            terminate,
          })),
        },
      },
    });

    await expect(
      flamecast.createSession({
        spawn: { command: "node", args: ["agent.js"] },
      }),
    ).rejects.toThrow("initialize failed");
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
