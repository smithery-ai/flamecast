import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleRequest } from "./handler.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent-source.txt"), "utf8");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const app = new Hono();
app.use("*", cors());

app.all("*", async (c) => {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!databaseUrl) {
    return c.json({ error: "DATABASE_URL or POSTGRES_URL is required" }, 500);
  }

  try {
    return await handleRequest(c.req.raw, databaseUrl, {
      e2bApiKey: requireEnv("E2B_API_KEY"),
      agentSource,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vercel] Unhandled error:", message, err instanceof Error ? err.stack : "");
    return c.json({ error: message }, 500);
  }
});

export default app;
