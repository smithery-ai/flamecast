import { afterEach, describe, expect, test } from "vitest";
import { LocalRuntimeClient } from "../../../packages/flamecast/src/runtime/local.ts";
import { MemoryFlamecastStorage } from "../../../packages/flamecast/src/flamecast/storage/memory/index.ts";
import { createCloudflareWorkerRuntimeProvider } from "../src/runtime-provider.js";
import { startExampleMiniflare } from "../src/miniflare.js";

let cleanup = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.map((fn) => fn()));
  cleanup = [];
});

function collectToolUpdates(events) {
  return events
    .filter((event) => event.type === "rpc")
    .map((event) => event.data.payload?.update)
    .filter(Boolean)
    .filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
}

describe("agent.js example", () => {
  test("runs executeJS over ACP and preserves session scope across prompts", async () => {
    const local = await startExampleMiniflare({
      bindings: {
        AGENT_MODE: "scripted",
      },
      port: 0,
    });
    cleanup.push(() => local.dispose());

    const storage = new MemoryFlamecastStorage();
    const runtimeClient = new LocalRuntimeClient({
      runtimeProviders: {
        "agent.js": createCloudflareWorkerRuntimeProvider({
          websocketUrl: local.websocketUrl,
        }),
      },
      getStorage: () => storage,
    });

    const events = [];
    const { sessionId } = await runtimeClient.startSession({
      agentName: "agent.js",
      spawn: { command: "unused", args: [] },
      cwd: process.cwd(),
      runtime: { provider: "agent.js" },
      startedAt: new Date().toISOString(),
    });

    cleanup.push(() => runtimeClient.terminateSession(sessionId));
    const unsubscribe = runtimeClient.subscribe(sessionId, (event) => events.push(event));
    cleanup.push(async () => unsubscribe());

    const first = await runtimeClient.promptSession(sessionId, "Increment the counter and return it.");
    const second = await runtimeClient.promptSession(sessionId, "Increment the counter again and return it.");

    expect(first).toEqual({ stopReason: "end_turn" });
    expect(second).toEqual({ stopReason: "end_turn" });

    const toolUpdates = collectToolUpdates(events);
    const completed = toolUpdates.filter((update) => update.status === "completed");

    expect(completed).toHaveLength(2);
    expect(completed[0].rawOutput.result).toEqual({ counter: 1 });
    expect(completed[1].rawOutput.result).toEqual({ counter: 2 });
  });
});
