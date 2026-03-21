import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("flamecast createAgent failure cleanup", () => {
  test("terminates the started runtime when ACP initialization fails", async () => {
    const terminate = vi.fn(async () => {});

    vi.doMock("@agentclientprotocol/sdk", async () => {
      class FailingClientSideConnection {
        constructor(_factory: unknown, _stream: unknown) {}

        async initialize() {
          throw new Error("initialize failed");
        }
      }

      return {
        ...acp,
        AGENT_METHODS: acp.AGENT_METHODS,
        CLIENT_METHODS: acp.CLIENT_METHODS,
        PROTOCOL_VERSION: acp.PROTOCOL_VERSION,
        ndJsonStream: vi.fn(() => ({ kind: "stream" })),
        ClientSideConnection: FailingClientSideConnection,
      };
    });

    const { Flamecast } = await import("../src/flamecast/index.js?create-agent-failure");

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
      flamecast.createAgent({
        spawn: { command: "node", args: ["agent.js"] },
      }),
    ).rejects.toThrow("initialize failed");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("creates the initial session during agent creation when requested", async () => {
    vi.doMock("@agentclientprotocol/sdk", async () => {
      class ClientSideConnection {
        constructor(_factory: unknown, _stream: unknown) {}

        async initialize() {}

        async newSession() {
          return { sessionId: "session-1" };
        }
      }

      return {
        ...acp,
        AGENT_METHODS: acp.AGENT_METHODS,
        CLIENT_METHODS: acp.CLIENT_METHODS,
        PROTOCOL_VERSION: acp.PROTOCOL_VERSION,
        ndJsonStream: vi.fn(() => ({ kind: "stream" })),
        ClientSideConnection,
      };
    });

    const { Flamecast } = await import("../src/flamecast/index.js?create-agent-initial-session");

    const flamecast = new Flamecast({
      storage: "memory",
      runtimeProviders: {
        local: {
          start: vi.fn(async () => ({
            transport: {
              input: new WritableStream<Uint8Array>(),
              output: new ReadableStream<Uint8Array>(),
            },
            terminate: async () => {},
          })),
        },
      },
    });

    const agent = await flamecast.createAgent({
      spawn: { command: "node", args: ["agent.js"] },
      initialSessionCwd: ".",
    });

    expect(agent.latestSessionId).toBe("session-1");
    expect(agent.sessionCount).toBe(1);

    const sessions = await flamecast.listSessions();
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "session-1",
        agentId: agent.id,
      }),
    ]);
  });
});
