import { describe, expect } from "vitest";
import alchemy from "alchemy";
import "alchemy/test/vitest";
import { Hono } from "hono";
import { hc } from "hono/client";
import { z } from "zod";
import { Flamecast } from "../src/flamecast/index.js";
import { createApi, type AppType } from "../src/flamecast/api.js";
import { PendingPermissionSchema, SessionSchema } from "../src/shared/session.js";

type AlchemyTestFactory = (meta: ImportMeta, opts: { prefix: string }) => typeof describe;

function isAlchemyTestFactory(value: unknown): value is AlchemyTestFactory {
  return typeof value === "function";
}

const maybeAlchemyTest = Reflect.get(alchemy, "test");

if (!isAlchemyTestFactory(maybeAlchemyTest)) {
  throw new Error("alchemy.test is unavailable");
}

const test = maybeAlchemyTest(import.meta, { prefix: "test" });

const PromptResultSchema = z.object({
  stopReason: z.string(),
});

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
  sessionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.sessions[":id"].$get({ param: { id: sessionId } });
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

  test("list sessions (empty)", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(flamecast);

    try {
      const res = await client.sessions.$get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("404 for unknown session", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(flamecast);

    try {
      const res = await client.sessions[":id"].$get({ param: { id: "nonexistent" } });
      expect(res.status).toBe(404);
    } finally {
      await alchemy.destroy(scope);
    }
  });

  test("full lifecycle through HTTP", async (scope: unknown) => {
    const flamecast = new Flamecast({ storage: "memory" });
    const client = createClient(flamecast);

    try {
      const createRes = await client.sessions.$post({
        json: { spawn: { command: "npx", args: ["tsx", "src/flamecast/agent.ts"] } },
      });
      expect(createRes.status).toBe(201);
      const session = SessionSchema.parse(await createRes.json());
      expect(session.id).toBeTruthy();

      const sessionId = session.id;

      const getRes = await client.sessions[":id"].$get({ param: { id: sessionId } });
      expect(getRes.status).toBe(200);

      const promptPromise = client.sessions[":id"].prompt.$post({
        param: { id: sessionId },
        json: { text: "Hello from API contract test!" },
      });

      const pending = await pollForPermission(client, sessionId, 15_000);
      expect(pending).toBeDefined();

      const allow = pending.options.find(
        (option: { optionId: string }) => option.optionId === "allow",
      );
      if (!allow) throw new Error("No allow option");

      const permRes = await client.sessions[":id"].permissions[":requestId"].$post({
        param: { id: sessionId, requestId: pending.requestId },
        json: { optionId: allow.optionId },
      });
      expect(permRes.status).toBe(200);

      const promptRes = await promptPromise;
      expect(promptRes.status).toBe(200);
      const result = PromptResultSchema.parse(await promptRes.json());
      expect(result.stopReason).toBe("end_turn");

      const killRes = await client.sessions[":id"].$delete({ param: { id: sessionId } });
      expect(killRes.status).toBe(200);
    } finally {
      await alchemy.destroy(scope);
    }
  });
});
