import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi, type AppType } from "../src/flamecast/api.js";
import {
  PendingPermissionSchema,
  PromptResultSchema,
  SessionSchema,
} from "../src/shared/session.js";

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

function createClient(flamecast: Flamecast) {
  const api = createApi(flamecast);
  const app = new Hono().route("/api", api);
  return hc<AppType>("http://localhost/api", {
    fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      return app.fetch(new Request(String(input), init));
    },
  });
}

async function pollForPermission(
  client: ReturnType<typeof createClient>,
  agentId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.agents[":agentId"].$get({ param: { agentId } });
    const payload = await res.json();
    const parsed = SessionSchema.safeParse(payload);
    if (parsed.success && parsed.data.pendingPermission) {
      return PendingPermissionSchema.parse(parsed.data.pendingPermission);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No pending permission after ${timeoutMs}ms`);
}

describe("api contract", () => {
  test("list agent templates", async (scope: unknown) => {
    const flamecast = new Flamecast({});
    const client = createClient(flamecast);

    try {
      const res = await client["agent-templates"].$get();
      expect(res.status).toBe(200);
      const templates = await res.json();
      expect(templates.length).toBeGreaterThan(0);
      expect(templates.find((template: { id: string }) => template.id === "example")).toBeDefined();
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("list agents (empty)", async (scope: unknown) => {
    const flamecast = new Flamecast({});
    const client = createClient(flamecast);

    try {
      const res = await client.agents.$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("404 for unknown agent", async (scope: unknown) => {
    const flamecast = new Flamecast({});
    const client = createClient(flamecast);

    try {
      const res = await client.agents[":agentId"].$get({ param: { agentId: "nonexistent" } });
      expect(res.status).toBe(404);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("full lifecycle through HTTP", async (scope: unknown) => {
    const flamecast = new Flamecast({});
    const client = createClient(flamecast);

    try {
      const createRes = await client.agents.$post({
        json: {
          spawn: { command: "pnpm", args: ["exec", "tsx", exampleAgentEntrypoint] },
        },
      });
      expect(createRes.status).toBe(201);
      const session = SessionSchema.parse(await createRes.json());
      expect(session.id).toBeTruthy();

      // Route renames land before the data model split, so the agent ID is still the ACP session ID.
      const agentId = session.id;

      const getRes = await client.agents[":agentId"].$get({ param: { agentId } });
      expect(getRes.status).toBe(200);

      const promptPromise = client.agents[":agentId"].prompt.$post({
        param: { agentId },
        json: { text: "Hello from API contract test!" },
      });

      const pending = await pollForPermission(client, agentId, 15_000);
      expect(pending).toBeDefined();

      const allow = pending.options.find(
        (option: { optionId: string }) => option.optionId === "allow",
      );
      if (!allow) throw new Error("No allow option");

      const permRes = await client.agents[":agentId"].permissions[":requestId"].$post({
        param: { agentId, requestId: pending.requestId },
        json: { optionId: allow.optionId },
      });
      expect(permRes.status).toBe(200);

      const promptRes = await promptPromise;
      expect(promptRes.status).toBe(200);
      const result = PromptResultSchema.parse(await promptRes.json());
      expect(result.stopReason).toBe("end_turn");

      const killRes = await client.agents[":agentId"].$delete({ param: { agentId } });
      expect(killRes.status).toBe(200);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
