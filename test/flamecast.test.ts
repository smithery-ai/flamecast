import { describe, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { File } from "alchemy/fs";
import * as docker from "alchemy/docker";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Flamecast } from "../src/flamecast/index.js";
import { createAcpClientConnection } from "../src/shared/acp-client-connection.js";
import type { RuntimeProvider } from "../src/flamecast/runtime-provider.js";

type AlchemyTestFactory = (meta: ImportMeta, opts: { prefix: string }) => typeof describe;

function isAlchemyTestFactory(value: unknown): value is AlchemyTestFactory {
  return typeof value === "function";
}

const maybeAlchemyTest = Reflect.get(alchemy, "test");

if (!isAlchemyTestFactory(maybeAlchemyTest)) {
  throw new Error("alchemy.test is unavailable");
}

const test = maybeAlchemyTest(import.meta, { prefix: "test" });

async function pollForPendingPermission(
  flamecast: Flamecast,
  agentId: string,
  sessionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await flamecast.getSession(agentId, sessionId);
    if (session.pendingPermission) return session.pendingPermission;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No pending permission after ${timeoutMs}ms`);
}

async function waitForPermissionRequest(
  pendingPermissions: Map<
    string,
    {
      request: acp.RequestPermissionRequest;
      resolve: (response: acp.RequestPermissionResponse) => void;
    }
  >,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = pendingPermissions.values().next().value;
    if (pending) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No ACP permission request after ${timeoutMs}ms`);
}

function hasDockerDaemon(): boolean {
  const dockerInfo = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (!dockerInfo.error) {
    return dockerInfo.status === 0;
  }
  const dockerHost = process.env.DOCKER_HOST?.replace(/^unix:\/\//, "");
  const socketCandidates = [
    dockerHost,
    path.join(homedir(), ".docker", "run", "docker.sock"),
    "/var/run/docker.sock",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return socketCandidates.some((candidate) => existsSync(candidate));
}

async function runAgentLifecycle(
  flamecast: Flamecast,
  createBody: Parameters<Flamecast["createAgent"]>[0],
) {
  const agent = await flamecast.createAgent(createBody);
  expect(agent.id).toBeTruthy();

  const server = await flamecast.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve Flamecast test server port");
  }

  const { connection, transport, pendingPermissions } = await createAcpClientConnection(
    new URL(`http://127.0.0.1:${address.port}/api/agents/${agent.id}/acp`),
  );

  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  try {
    const session = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(session.sessionId).toBeTruthy();

    const promptPromise = connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Hello from integration test!" }],
    });

    const pending = await pollForPendingPermission(flamecast, agent.id, session.sessionId, 15_000);
    expect(pending.options.length).toBeGreaterThanOrEqual(2);

    const permissionRequest = await waitForPermissionRequest(pendingPermissions, 5_000);
    permissionRequest.resolve({
      outcome: {
        outcome: "selected",
        optionId: "allow",
      },
    });

    const result = await promptPromise;
    expect(result.stopReason).toBe("end_turn");

    const state = await flamecast.getSession(agent.id, session.sessionId);
    expect(state.logs.length).toBeGreaterThan(0);
  } finally {
    await transport.close().catch(() => undefined);
    await flamecast.terminateAgent(agent.id).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

describe("flamecast", () => {
  test("local - full agent/session lifecycle", async (scope: unknown) => {
    const flamecast = new Flamecast({
      storage: "memory",
    });

    try {
      await runAgentLifecycle(flamecast, {
        spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
      });
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("local - agent template is optional but supported", async (scope: unknown) => {
    const flamecast = new Flamecast({
      storage: "memory",
    });

    try {
      const templates = await flamecast.listAgentTemplates();
      expect(templates.length).toBeGreaterThan(0);
      expect(templates.find((template) => template.id === "example")).toBeDefined();

      await runAgentLifecycle(flamecast, { agentTemplateId: "example" });
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("local - agent management", async (scope: unknown) => {
    const flamecast = new Flamecast({
      storage: "memory",
    });

    try {
      const agents = await flamecast.listAgents();
      const sessions = await flamecast.listSessions();
      expect(Array.isArray(agents)).toBe(true);
      expect(Array.isArray(sessions)).toBe(true);

      await expect(flamecast.getAgent("nonexistent")).rejects.toThrow();
      await expect(flamecast.getSession("nonexistent", "missing")).rejects.toThrow();
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("custom runtime provider - creates a resource", async (scope: unknown) => {
    const testFilePath = `.alchemy-test-${Date.now()}.txt`;

    const fixtureProvider: RuntimeProvider = {
      async start() {
        await File("fixture-runtime", {
          path: testFilePath,
          content: "provisioned",
        });

        throw new Error("fixture runtime unavailable");
      },
    };

    const flamecast = new Flamecast({
      storage: "memory",
      runtimeProviders: { fixture: fixtureProvider },
      agentTemplates: [
        {
          id: "fixture",
          name: "Fixture agent",
          spawn: { command: "unused", args: [] },
          runtime: { provider: "fixture" },
        },
      ],
    });

    try {
      await expect(flamecast.createAgent({ agentTemplateId: "fixture" })).rejects.toThrow(
        "fixture runtime unavailable",
      );
    } finally {
      await alchemy.destroy(scope);
      if (existsSync(testFilePath)) rmSync(testFilePath);
    }
  });

  test.skipIf(!hasDockerDaemon())(
    "docker runtime provider - container lifecycle wiring",
    async (_scope: unknown) => {
      let containerCreated = false;
      let containerId = "";

      const dockerProvider: RuntimeProvider = {
        async start() {
          const container = await docker.Container("sandbox", {
            image: "nginx:latest",
            name: `flamecast-test-${Date.now()}`,
            ports: [{ external: 0, internal: 80 }],
            start: true,
          });
          containerCreated = true;
          containerId = container.id;
          throw new Error("docker ACP handshake unavailable");
        },
      };

      const flamecast = new Flamecast({
        storage: "memory",
        runtimeProviders: { fixture: dockerProvider },
        agentTemplates: [
          {
            id: "fixture",
            name: "Fixture agent",
            spawn: { command: "unused", args: [] },
            runtime: { provider: "fixture" },
          },
        ],
      });

      try {
        await flamecast.createAgent({ agentTemplateId: "fixture" });
      } catch {
        // Expected - this test only verifies provider wiring.
      }

      expect(containerCreated).toBe(true);
      expect(containerId).toBeTruthy();
    },
  );
});
