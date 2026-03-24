import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@agentclientprotocol/sdk");
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
        PROTOCOL_VERSION: "test-protocol",
        AGENT_METHODS: {
          initialize: "initialize",
          session_new: "session/new",
        },
        CLIENT_METHODS: {
          session_update: "session/update",
          session_request_permission: "session/request_permission",
        },
        ndJsonStream: vi.fn(() => ({ kind: "stream" })),
        ClientSideConnection: FailingClientSideConnection,
      };
    });

    const { Flamecast } = await import("../src/flamecast/index.js?create-session-failure");

    const flamecast = new Flamecast({
      storage: new MemoryFlamecastStorage(),
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
