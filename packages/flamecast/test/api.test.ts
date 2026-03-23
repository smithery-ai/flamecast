import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi, type AppType } from "../src/flamecast/api.js";
import { SessionSchema } from "../src/shared/session.js";

type AlchemyTestFactory = (meta: ImportMeta, opts: { prefix: string }) => typeof describe;

function isAlchemyTestFactory(value: unknown): value is AlchemyTestFactory {
  return typeof value === "function";
}

const maybeAlchemyTest = Reflect.get(alchemy, "test");

if (!isAlchemyTestFactory(maybeAlchemyTest)) {
  throw new Error("alchemy.test is unavailable");
}

const test = maybeAlchemyTest(import.meta, { prefix: "test" });

function createClient(flamecast: Flamecast) {
  const api = createApi(flamecast);
  const app = new Hono().route("/api", api);
  return hc<AppType>("http://localhost/api", {
    fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      return app.fetch(new Request(String(input), init));
    },
  });
}

describe("api contract", () => {
  test("list agent templates", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
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
    const flamecast = new Flamecast({ storage: "memory" });
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
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(flamecast);

    try {
      const res = await client.agents[":agentId"].$get({ param: { agentId: "nonexistent" } });
      expect(res.status).toBe(404);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("session lifecycle with create get list terminate", async (scope: unknown) => {
    const exampleAgentEntrypoint = fileURLToPath(new URL("../src/flamecast/agent.ts", import.meta.url));
    const flamecast = new Flamecast({ storage: "memory" });
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

      const agentId = session.id;

      const getRes = await client.agents[":agentId"].$get({ param: { agentId } });
      expect(getRes.status).toBe(200);

      const listRes = await client.agents.$get();
      expect(listRes.status).toBe(200);
      const agents = await listRes.json();
      expect(agents.length).toBeGreaterThanOrEqual(1);

      const killRes = await client.agents[":agentId"].$delete({ param: { agentId } });
      expect(killRes.status).toBe(200);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
