import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("flamecast createSession MCP configuration", () => {
  test("starts ACP sessions with an empty MCP server list", async () => {
    let capturedParams: { cwd: string; mcpServers: unknown[] } | null = null;

    vi.doMock("@agentclientprotocol/sdk", async () => {
      const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
        "@agentclientprotocol/sdk",
      );

      class CapturingClientSideConnection {
        constructor(_factory: unknown, _stream: unknown) {}

        async initialize() {
          return {};
        }

        async newSession(params: { cwd: string; mcpServers: unknown[] }) {
          capturedParams = params;
          return { sessionId: "session-1" };
        }
      }

      return {
        ...actual,
        ndJsonStream: vi.fn(() => ({ kind: "stream" })),
        ClientSideConnection: CapturingClientSideConnection,
      };
    });

    const { Flamecast } = await import("../src/flamecast/index.js?create-session-mcp");
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
      cwd: process.cwd(),
      spawn: { command: "node", args: ["agent.js"] },
    });

    expect(session.id).toBe("session-1");
    expect(capturedParams).toEqual({
      cwd: await realpath(process.cwd()),
      mcpServers: [],
    });
  });
});
