import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { Flamecast } from "../../../packages/flamecast/src/flamecast/index.ts";
import { MemoryFlamecastStorage } from "../../../packages/flamecast/src/flamecast/storage/memory/index.ts";
import { AgentJsRuntime } from "../src/flamecast-runtime.js";
import { startExampleMiniflare } from "../src/miniflare.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((fn) => fn()),
  );
});

async function readJson(response: Response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

async function openSessionSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Session WebSocket timed out")), 10_000);
    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      ws.off("error", onError);
      callback();
    };
    const onError = (error: Error) => finish(() => reject(error));

    ws.once("open", () => finish(resolve));
    ws.once("error", onError);
  });

  return ws;
}

async function promptSession(ws: WebSocket, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let completedResult: unknown;
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Timed out waiting for prompt completion: ${text}`));
    }, 20_000);

    const cleanupListeners = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };

    const onClose = () => {
      cleanupListeners();
      reject(new Error("Session WebSocket closed before prompt completed"));
    };

    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data));

      if (message.type === "error") {
        cleanupListeners();
        reject(new Error(message.message));
        return;
      }

      if (message.type !== "event" || message.event?.type !== "rpc") {
        return;
      }

      const rpc = message.event.data;
      const update = rpc?.payload?.update;
      if (
        update &&
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.status === "completed"
      ) {
        completedResult = update.rawOutput?.result;
      }

      if (rpc?.method === "session/prompt" && rpc.phase === "response") {
        cleanupListeners();
        resolve(completedResult);
      }
    };

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
    ws.send(JSON.stringify({ action: "prompt", text }));
  });
}

describe("agent.js runtime", () => {
  test("registers and runs the agent.js worker through the Flamecast API", async () => {
    const remoteAgent = await startExampleMiniflare({
      bindings: { AGENT_MODE: "scripted" },
      port: 0,
    });
    cleanup.push(() => remoteAgent.dispose());

    const flamecast = new Flamecast({
      storage: new MemoryFlamecastStorage(),
      runtimes: {
        agentjs: new AgentJsRuntime(),
      },
    });
    cleanup.push(() => flamecast.shutdown());

    const template = await readJson(
      await flamecast.app.request("/api/agent-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Agent.js remote",
          spawn: { command: "remote-acp", args: ["agent.js"] },
          runtime: { provider: "agentjs", baseUrl: remoteAgent.baseUrl },
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
