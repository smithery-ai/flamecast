import { afterEach, describe, expect, test, vi } from "vitest";

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

    vi.resetModules();
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

  test("buffers startup notifications until the session row exists", async () => {
    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );

      class StartupNotificationConnection {
        private readonly client: {
          sessionUpdate: (params: {
            sessionId: string;
            update: { sessionUpdate: string; availableCommands: unknown[] };
          }) => Promise<void>;
        };

        constructor(
          factory: (agent: unknown) => {
            sessionUpdate: (params: {
              sessionId: string;
              update: { sessionUpdate: string; availableCommands: unknown[] };
            }) => Promise<void>;
          },
          _stream: unknown,
        ) {
          this.client = factory({});
        }

        async initialize() {
          return {};
        }

        async newSession() {
          await this.client.sessionUpdate({
            sessionId: "session-startup",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "review", description: "Review changes", input: null }],
            },
          });
          return { sessionId: "session-startup" };
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
        ClientSideConnection: StartupNotificationConnection,
      };
    });

    vi.resetModules();
    const { Flamecast } = await import("../src/flamecast/index.js?startup-notification-buffer");

    const flamecast = new Flamecast({
      storage: "memory",
      runtimeProviders: {
        local: {
          start: vi.fn(async () => ({
            transport: {
              input: new WritableStream<Uint8Array>(),
              output: new ReadableStream<Uint8Array>(),
            },
            terminate: vi.fn(async () => {}),
          })),
        },
      },
    });

    const session = await flamecast.createSession({
      spawn: { command: "node", args: ["agent.js"] },
    });

    expect(session.id).toBe("session-startup");
    expect(session.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "rpc",
          data: expect.objectContaining({
            method: "session/update",
            direction: "agent_to_client",
            phase: "notification",
            payload: expect.objectContaining({
              sessionId: "session-startup",
              update: expect.objectContaining({
                sessionUpdate: "available_commands_update",
              }),
            }),
          }),
        }),
      ]),
    );
  });
});
