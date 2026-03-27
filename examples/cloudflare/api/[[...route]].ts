import { handleRequest } from "../src/app.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(__dirname, "../agent-source.txt"), "utf8");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export default async function handler(request: Request): Promise<Response> {
  return handleRequest(request, requireEnv("DATABASE_URL"), {
    e2bApiKey: requireEnv("E2B_API_KEY"),
    agentSource,
  });
}
