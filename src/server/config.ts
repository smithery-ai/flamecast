import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ServerConfigSchema = z.object({
  stateManager: z.enum(["memory", "psql"]).default("psql"),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const DEFAULT_CONFIG: ServerConfig = { stateManager: "psql" };

function configPathFromEnv(): string {
  const fromEnv = process.env.ACP_CONFIG_PATH?.trim();
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  return path.join(process.cwd(), "config.yaml");
}

/**
 * Loads `config.yaml` from the current working directory, or `ACP_CONFIG_PATH` (relative to cwd).
 * Missing file → `{ stateManager: "psql" }` (same as previous server default).
 */
export async function loadServerConfig(): Promise<ServerConfig> {
  const configPath = configPathFromEnv();
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: unknown) {
    const code = typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
    if (code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }
  const parsed: unknown = raw.trim() === "" ? {} : parseYaml(raw);
  return ServerConfigSchema.parse(parsed ?? {});
}
