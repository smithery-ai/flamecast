import { afterEach, describe, expect, test } from "vitest";
import { Flamecast, NodeRuntime } from "../../../packages/flamecast/src/flamecast/index.ts";
import { MemoryFlamecastStorage } from "../../../packages/flamecast/src/flamecast/storage/memory/index.ts";
import { openSessionSocket, promptSession, readJson } from "./session-host.js";
import { startExampleWorker } from "./wrangler.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((fn) => fn()),
  );
});

describe("agent.js runtime", () => {
  test("registers and runs the hosted worker through Flamecast via NodeRuntime", async () => {
    const remoteAgent = await startExampleWorker({
      bindings: { AGENT_MODE: "scripted" },
    });
    cleanup.push(() => remoteAgent.dispose());

    const flamecast = new Flamecast({
      storage: new MemoryFlamecastStorage(),
      runtimes: {
        agentjs: new NodeRuntime(remoteAgent.baseUrl),
      },
    });
    cleanup.push(() => flamecast.shutdown());

    const template = await readJson(
      await flamecast.app.request("/api/agent-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Agent.js remote",
          spawn: { command: "remote-sessionhost", args: ["agentjs"] },
          runtime: { provider: "agentjs" },
        }),
      }),
    );

    const firstSession = await readJson(
      await flamecast.app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentTemplateId: template.id }),
      }),
    );
    const secondSession = await readJson(
      await flamecast.app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentTemplateId: template.id }),
      }),
    );

    expect(firstSession.agentName).toBe("Agent.js remote");
    expect(firstSession.websocketUrl).toBeTruthy();
    expect(secondSession.websocketUrl).toBeTruthy();
    expect(firstSession.id).not.toBe(secondSession.id);

    const firstWs = await openSessionSocket(firstSession.websocketUrl);
    cleanup.push(
      () =>
        new Promise((resolve) => {
          firstWs.once("close", () => resolve());
          firstWs.close();
        }),
    );
    const secondWs = await openSessionSocket(secondSession.websocketUrl);
    cleanup.push(
      () =>
        new Promise((resolve) => {
          secondWs.once("close", () => resolve());
          secondWs.close();
        }),
    );

    const first = await promptSession(firstWs, "Increment the counter and return it.");
    const second = await promptSession(firstWs, "Increment the counter again and return it.");
    const isolated = await promptSession(secondWs, "Increment the counter and return it.");

    expect(first).toEqual({ counter: 1 });
    expect(second).toEqual({ counter: 2 });
    expect(isolated).toEqual({ counter: 1 });
  });
});
