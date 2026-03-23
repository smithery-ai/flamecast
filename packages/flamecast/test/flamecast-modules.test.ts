import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { getBuiltinAgentTemplates, localRuntime } from "../src/flamecast/agent-templates.js";
import { MemoryFlamecastStorage } from "../src/flamecast/storage/memory/index.js";

function createTemplate(id: string, name: string) {
  return {
    id,
    name,
    spawn: {
      command: "node",
      args: [`${id}.js`],
    },
    runtime: {
      provider: "local",
    },
  };
}

function createSessionMeta(id: string) {
  return {
    id,
    agentName: "Example agent",
    spawn: { command: "node", args: ["agent.js"] },
    startedAt: "2024-01-01T00:00:00.000Z",
    lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    status: "active" as const,
    pendingPermission: null,
  };
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const exampleAgentEntrypoint = fileURLToPath(new URL("../src/flamecast/agent.ts", import.meta.url));

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("agent templates", () => {
  test("returns built-ins and respects the windows pnpm shim", () => {
    const unixTemplates = getBuiltinAgentTemplates();

    expect(unixTemplates.map((template) => template.id)).toEqual([
      "example",
      "codex",
      "example-docker",
      "example-docker-2",
    ]);
    expect(unixTemplates[0]?.spawn.command).toBe("pnpm");
    expect(unixTemplates[0]?.spawn.args).toEqual(["exec", "tsx", exampleAgentEntrypoint]);
    expect(localRuntime()).toEqual({ provider: "local" });

    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    const windowsTemplates = getBuiltinAgentTemplates();
    expect(windowsTemplates[0]?.spawn.command).toBe("pnpm.cmd");
  });
});

describe("memory storage", () => {
  test("seeds templates, preserves user templates, and clones stored values", async () => {
    const storage = new MemoryFlamecastStorage();
    const presetOne = createTemplate("preset-1", "Preset One");
    const presetTwo = createTemplate("preset-2", "Preset Two");
    const custom = createTemplate("custom-1", "Custom One");

    await storage.seedAgentTemplates([presetOne, presetTwo]);
    expect((await storage.listAgentTemplates()).map((template) => template.id)).toEqual([
      "preset-1",
      "preset-2",
    ]);

    const listed = await storage.listAgentTemplates();
    listed[0]?.spawn.args.push("mutated");
    expect(await storage.getAgentTemplate("preset-1")).toMatchObject({
      spawn: { args: ["preset-1.js"] },
    });

    await storage.saveAgentTemplate(custom);
    await storage.seedAgentTemplates([presetTwo]);

    expect((await storage.listAgentTemplates()).map((template) => template.id)).toEqual([
      "preset-2",
      "custom-1",
    ]);
    expect(await storage.getAgentTemplate("missing")).toBeNull();
  });

  test("stores sessions and logs with the expected error handling", async () => {
    const storage = new MemoryFlamecastStorage();
    const meta = createSessionMeta("session-1");

    await expect(storage.updateSession("missing", {})).rejects.toThrow(
      'Session "missing" not found in storage',
    );
    await expect(
      storage.appendLog("missing", { timestamp: "t", type: "rpc", data: {} }),
    ).rejects.toThrow('Session "missing" has no log stream');

    await storage.createSession(meta);
    await storage.updateSession(meta.id, { lastUpdatedAt: "2024-01-02T00:00:00.000Z" });
    await storage.updateSession(meta.id, {
      pendingPermission: {
        requestId: "request-1",
        toolCallId: "tool-1",
        title: "Approve",
        options: [],
      },
    });
    await storage.appendLog(meta.id, {
      timestamp: "2024-01-02T00:00:00.000Z",
      type: "rpc",
      data: { ok: true },
    });

    expect(await storage.getSessionMeta(meta.id)).toMatchObject({
      lastUpdatedAt: "2024-01-02T00:00:00.000Z",
      pendingPermission: {
        requestId: "request-1",
      },
    });
    expect(await storage.getLogs(meta.id)).toEqual([
      {
        timestamp: "2024-01-02T00:00:00.000Z",
        type: "rpc",
        data: { ok: true },
      },
    ]);

    await storage.finalizeSession(meta.id, "terminated");
    expect((await storage.getSessionMeta(meta.id))?.status).toBe("killed");
    expect(await storage.getLogs(meta.id)).toEqual([
      {
        timestamp: "2024-01-02T00:00:00.000Z",
        type: "rpc",
        data: { ok: true },
      },
    ]);
  });
});
