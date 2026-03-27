import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2BRuntime } from "@flamecast/runtime-e2b";
import { Flamecast } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";
import dotenv from "dotenv";
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

let flamecastPromise: Promise<Flamecast<{ e2b: E2BRuntime }>> | null = null;

async function createFlamecast(): Promise<Flamecast<{ e2b: E2BRuntime }>> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required");
  }

  const storage = await createPsqlStorage({ url: databaseUrl });

  return new Flamecast({
    storage,
    runtimes: {
      e2b: new E2BRuntime({ apiKey: requireEnv("E2B_API_KEY") }),
    },
    agentTemplates: createAgentTemplates({ agentSource }),
  });
}

export function getFlamecast(): Promise<Flamecast<{ e2b: E2BRuntime }>> {
  flamecastPromise ??= createFlamecast();
  return flamecastPromise;
}
