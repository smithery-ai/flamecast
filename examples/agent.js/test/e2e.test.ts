import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  closeSessionSocket,
  openSessionSocket,
  promptSession,
  subscribeToSession,
  startSession,
  terminateSession,
} from "./session-host.js";
import { startExampleWorker } from "./wrangler.js";

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.map((fn) => fn()));
  cleanup = [];
});

describe("agent.js example", () => {
  test("runs executeJS through SessionHost and preserves session scope across prompts", async () => {
    const local = await startExampleWorker({
      bindings: { AGENT_MODE: "scripted" },
    });
    cleanup.push(() => local.dispose());

    const sessionId = `counter-${randomUUID()}`;
    const session = await startSession(local.baseUrl, sessionId);
    cleanup.push(() => terminateSession(local.baseUrl, sessionId));
    const ws = await openSessionSocket(session.websocketUrl);
    await subscribeToSession(ws, sessionId);
    cleanup.push(() => closeSessionSocket(ws));

    expect(session.websocketUrl).toBe(local.baseUrl.replace(/^http/, "ws"));

    const first = await promptSession(ws, sessionId, "Increment the counter and return it.");
    const second = await promptSession(ws, sessionId, "Increment the counter again and return it.");

    expect(first).toEqual({ counter: 1 });
    expect(second).toEqual({ counter: 2 });
  });

  test("supports node:fs access against the virtual tmp filesystem contract", async () => {
    const local = await startExampleWorker({
      bindings: { AGENT_MODE: "scripted" },
    });
    cleanup.push(() => local.dispose());

    const sessionId = `tmp-${randomUUID()}`;
    const session = await startSession(local.baseUrl, sessionId);
    cleanup.push(() => terminateSession(local.baseUrl, sessionId));
    const ws = await openSessionSocket(session.websocketUrl);
    await subscribeToSession(ws, sessionId);
    cleanup.push(() => closeSessionSocket(ws));

    const result = await promptSession(
      ws,
      sessionId,
      "Use node:fs to write a tmp file and return its contents.",
    );

    expect(result).toEqual({
      path: "/tmp/hello.txt",
      contents: "Hello from executeJS",
    });
  });

  test("persists session scope across websocket reconnects for the same session id", async () => {
    const local = await startExampleWorker({
      bindings: { AGENT_MODE: "scripted" },
    });
    cleanup.push(() => local.dispose());

    const sessionId = `reconnect-${randomUUID()}`;
    const session = await startSession(local.baseUrl, sessionId);
    cleanup.push(() => terminateSession(local.baseUrl, sessionId));
    const first = await openSessionSocket(session.websocketUrl);
    await subscribeToSession(first, sessionId);
    cleanup.push(() => closeSessionSocket(first));

    const firstResult = await promptSession(
      first,
      sessionId,
      "Increment the counter and return it.",
    );
    expect(firstResult).toEqual({ counter: 1 });

    await closeSessionSocket(first);

    const second = await openSessionSocket(session.websocketUrl);
    await subscribeToSession(second, sessionId);
    cleanup.push(() => closeSessionSocket(second));

    const secondResult = await promptSession(
      second,
      sessionId,
      "Increment the counter again and return it.",
    );

    expect(secondResult).toEqual({ counter: 2 });
  });
});
