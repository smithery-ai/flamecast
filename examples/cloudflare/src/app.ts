import { E2BRuntime } from "@flamecast/runtime-e2b";
import { Flamecast } from "@flamecast/sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAgentTemplates } from "./agent-templates.js";

export type FlamecastOptions = {
  e2bApiKey: string;
  agentSource: string;
  restateUrl?: string;
};

let e2bRuntime: E2BRuntime | null = null;
let agentTemplatesCache: ReturnType<typeof createAgentTemplates> | null = null;

export async function handleRequest(
  request: Request,
  options: FlamecastOptions,
): Promise<Response> {
  e2bRuntime ??= new E2BRuntime({ apiKey: options.e2bApiKey, template: "flamecast-node22" });
  agentTemplatesCache ??= createAgentTemplates({ agentSource: options.agentSource });

  const flamecast = new Flamecast({
    runtimes: { e2b: e2bRuntime },
    agentTemplates: agentTemplatesCache,
    restateUrl: options.restateUrl,
  });

  const app = new Hono();
  app.use("*", cors());
  app.route("/", flamecast.app);

  return await app.fetch(request);
}
