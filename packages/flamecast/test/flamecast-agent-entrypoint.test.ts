import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test("runs the agent entrypoint automatically when imported as the main module", async () => {
  const ndJsonStream = vi.fn(() => ({ kind: "stream" }));
  const AgentSideConnection = vi.fn();
  const originalArgv1 = process.argv[1];

  vi.doMock("@agentclientprotocol/sdk", async () => {
    const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>(
      "@agentclientprotocol/sdk",
    );
    return {
      ...actual,
      ndJsonStream,
      AgentSideConnection,
    };
  });

  try {
    vi.resetModules();
    process.argv[1] = fileURLToPath(new URL("../src/flamecast/agent.ts", import.meta.url));
    await import("../src/flamecast/agent.js");
  } finally {
    process.argv[1] = originalArgv1;
  }

  expect(ndJsonStream).toHaveBeenCalled();
  expect(AgentSideConnection).toHaveBeenCalled();
});
