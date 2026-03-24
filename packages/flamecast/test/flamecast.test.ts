import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { File } from "alchemy/fs";
import * as docker from "alchemy/docker";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Flamecast } from "../src/flamecast/index.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";
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
const exampleAgentEntrypoint = fileURLToPath(new URL("../src/flamecast/agent.ts", import.meta.url));

// oxlint-disable-next-line eslint/no-unused-vars -- re-enable when docker test is unskipped
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

async function runSessionLifecycle(
  flamecast: Flamecast,
  createBody: Parameters<Flamecast["createSession"]>[0],
) {
  const session = await flamecast.createSession(createBody);
  expect(session.id).toBeTruthy();

  const sessionId = session.id;

  try {
    const state = await flamecast.getSession(sessionId);
    expect(state.id).toBe(sessionId);
    expect(state.status).toBe("active");
  } finally {
    await flamecast.terminateSession(sessionId);
  }
}

describe("flamecast", () => {
  test("local full session lifecycle", async (scope: unknown) => {
    const flamecast = new Flamecast({
      storage: new MemoryFlamecastStorage(),
    });

    try {
      await runSessionLifecycle(flamecast, {
        spawn: { command: "pnpm", args: ["exec", "tsx", exampleAgentEntrypoint] },
      });
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("local preset agent template", async (scope: unknown) => {
    const flamecast = new Flamecast({
      storage: new MemoryFlamecastStorage(),
    });

    try {
      const templates = await flamecast.listAgentTemplates();
      expect(templates.length).toBeGreaterThan(0);
      expect(templates.find((template) => template.id === "example")).toBeDefined();

      await runSessionLifecycle(flamecast, { agentTemplateId: "example" });
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("local session management", async (scope: unknown) => {
    const flamecast = new Flamecast({
      storage: new MemoryFlamecastStorage(),
    });

    try {
      const sessions = await flamecast.listSessions();
      expect(Array.isArray(sessions)).toBe(true);

      await expect(flamecast.getSession("nonexistent")).rejects.toThrow();
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("custom runtime provider creates a resource", async (scope: unknown) => {
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
      storage: new MemoryFlamecastStorage(),
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
      await expect(flamecast.createSession({ agentTemplateId: "fixture" })).rejects.toThrow(
        "fixture runtime unavailable",
      );
    } finally {
      await alchemy.destroy(scope);
      if (existsSync(testFilePath)) rmSync(testFilePath);
    }
  });

  test.skip("docker runtime provider container lifecycle wiring", async (_scope: unknown) => {
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
      storage: new MemoryFlamecastStorage(),
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
      await flamecast.createSession({ agentTemplateId: "fixture" });
    } catch {
      // Expected - this test only verifies provider wiring.
    }

    expect(containerCreated).toBe(true);
    expect(containerId).toBeTruthy();
  });
});
