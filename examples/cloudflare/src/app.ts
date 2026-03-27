import { E2BRuntime } from "@flamecast/runtime-e2b";
import { Flamecast } from "@flamecast/sdk";
import { createStorageFromDb, schema } from "@flamecast/storage-psql/worker";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Client } from "pg";
import { createAgentTemplates } from "./agent-templates.js";

export type FlamecastOptions = {
  e2bApiKey: string;
  agentSource: string;
};

let e2bRuntime: E2BRuntime | null = null;
let agentTemplatesCache: ReturnType<typeof createAgentTemplates> | null = null;

/**
 * Create the long-lived parts of Flamecast (E2B runtime, agent templates)
 * once, but use a fresh pg connection per request.
 */
export async function handleRequest(
  request: Request,
  databaseUrl: string,
  options: FlamecastOptions,
): Promise<Response> {
  e2bRuntime ??= new E2BRuntime({ apiKey: options.e2bApiKey });
  agentTemplatesCache ??= createAgentTemplates({ agentSource: options.agentSource });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const db = drizzle({ client, schema });
    const storage = createStorageFromDb(db);

    const flamecast = new Flamecast({
      storage,
      runtimes: { e2b: e2bRuntime },
      agentTemplates: agentTemplatesCache,
    });

    // Wrap in CORS for cross-origin deployments (UI on different origin than API)
    const app = new Hono();
    app.use("*", cors());
    app.route("/", flamecast.app);

    return await app.fetch(request);
  } finally {
    await client.end();
  }
}
