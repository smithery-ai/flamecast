import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi, type AppType } from "../src/flamecast/api.js";
import { AgentSchema } from "../src/shared/session.js";

type AlchemyTestFactory = (meta: ImportMeta, opts: { prefix: string }) => typeof describe;

function isAlchemyTestFactory(value: unknown): value is AlchemyTestFactory {
  return typeof value === "function";
}

const maybeAlchemyTest = Reflect.get(alchemy, "test");

if (!isAlchemyTestFactory(maybeAlchemyTest)) {
  throw new Error("alchemy.test is unavailable");
}

const test = maybeAlchemyTest(import.meta, { prefix: "test" });

function createApp(flamecast: Flamecast) {
  const api = createApi(flamecast);
  return new Hono().route("/api", api);
}

function createClient(app: ReturnType<typeof createApp>) {
  return hc<AppType>("http://localhost/api", {
    fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      return app.fetch(new Request(String(input), init));
    },
  });
}

describe("api contract", () => {
  test("list sessions (empty)", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(createApp(flamecast));

    try {
      const res = await client.sessions.$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("404 for unknown agent", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(createApp(flamecast));

    try {
      const res = await client.agents[":agentId"].$get({ param: { agentId: "nonexistent" } });
      expect(res.status).toBe(404);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("creates agents through HTTP", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(createApp(flamecast));

    try {
      const createAgentRes = await client.agents.$post({
        json: {
          spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] },
        },
      });
      expect(createAgentRes.status).toBe(201);
      const agent = AgentSchema.parse(await createAgentRes.json());
      expect(agent.agentName).toBe("npx tsx src/flamecast/agent.ts");

      const listRes = await client.agents.$get();
      expect(listRes.status).toBe(200);
      const agents = await listRes.json();
      expect(agents).toHaveLength(1);
      expect(agents[0]?.id).toBe(agent.id);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
