import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Flamecast } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";
import type { Runtime } from "@flamecast/protocol/runtime";
import { createAgentTemplates } from "./agent-templates.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent.ts"), "utf8");

let flamecastPromise: Promise<Flamecast> | null = null;

async function createE2BRuntime() {
  const { E2BRuntime } = await import("@flamecast/runtime-e2b");
  return new E2BRuntime({ apiKey: requireEnv("E2B_API_KEY") });
}

async function createFlamecast(): Promise<Flamecast> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }

  const storage = await createPsqlStorage({ url: databaseUrl });
  const runtimes: Record<string, Runtime> = {
    e2b: await createE2BRuntime(),
  };

  return new Flamecast({
    storage,
    runtimes,
    agentTemplates: createAgentTemplates({ agentSource }),
  });
}

export function getFlamecast(): Promise<Flamecast> {
  flamecastPromise ??= createFlamecast();
  return flamecastPromise;
}
