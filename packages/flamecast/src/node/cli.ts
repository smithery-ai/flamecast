import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import {
  PSQL_MIGRATIONS_FOLDER,
  PSQL_SCHEMA_FILE,
  createPsqlStorage,
  migrateDatabase,
  resolveDatabaseOptions,
} from "@flamecast/storage-psql";
import dotenv from "dotenv";
import { Flamecast, NodeRuntime } from "../index.js";

export type ParsedDbArgs = {
  options: {
    url?: string;
    dataDir?: string;
  };
  passthrough: string[];
};

export function parsePort(value: string | undefined): number {
  if (!value) return 3001;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }
  return parsed;
}

export function parseDbArgs(args: readonly string[]): ParsedDbArgs {
  let url: string | undefined;
  let dataDir: string | undefined;
  const passthrough: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --url");
      }
      url = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
      continue;
    }

    if (arg === "--data-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --data-dir");
      }
      dataDir = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
      continue;
    }

    passthrough.push(arg);
  }

  return {
    options: {
      ...(url ? { url } : {}),
      ...(dataDir ? { dataDir } : {}),
    },
    passthrough,
  };
}

export function createDrizzleStudioConfig(
  options: Parameters<typeof resolveDatabaseOptions>[0],
): string {
  const resolved = resolveDatabaseOptions(options);
  const connectionConfig =
    "url" in resolved
      ? `  dialect: "postgresql",\n  dbCredentials: { url: ${JSON.stringify(resolved.url)} },`
      : `  dialect: "postgresql",\n  driver: "pglite",\n  dbCredentials: { url: ${JSON.stringify(resolved.dataDir)} },`;

  return [
    'import { defineConfig } from "drizzle-kit";',
    "",
    "export default defineConfig({",
    `  schema: ${JSON.stringify(PSQL_SCHEMA_FILE)},`,
    `  out: ${JSON.stringify(PSQL_MIGRATIONS_FOLDER)},`,
    connectionConfig,
    "});",
    "",
  ].join("\n");
}

function printHelp(): void {
  console.log(`Usage:
  flamecast
  flamecast db migrate [--url <postgres-url>] [--data-dir <path>]
  flamecast db studio [--url <postgres-url>] [--data-dir <path>] [--host <host>] [--port <port>] [--verbose]

Commands:
  db migrate   Apply bundled Flamecast schema migrations to Postgres or local PGLite
  db studio    Launch Drizzle Studio against the active Flamecast database
`);
}

async function resolveDrizzleKitBin(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageEntry = require.resolve("drizzle-kit");
  return path.resolve(path.dirname(packageEntry), "bin.cjs");
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function runDbMigrate(args: readonly string[]): Promise<number> {
  const { options, passthrough } = parseDbArgs(args);
  if (passthrough.length > 0) {
    throw new Error(`Unknown arguments for "flamecast db migrate": ${passthrough.join(" ")}`);
  }

  const resolved = resolveDatabaseOptions(options);
  await migrateDatabase(options);

  if ("url" in resolved) {
    console.log("Applied Flamecast migrations to PostgreSQL.");
  } else {
    console.log(`Applied Flamecast migrations to PGLite at ${resolved.dataDir}.`);
  }

  return 0;
}

async function runDbStudio(args: readonly string[]): Promise<number> {
  const { options, passthrough } = parseDbArgs(args);
  const drizzleKitBin = await resolveDrizzleKitBin();
  const tempDir = await mkdtemp(path.join(tmpdir(), "flamecast-drizzle-"));
  const configPath = path.join(tempDir, "drizzle.config.mjs");

  try {
    await writeFile(configPath, createDrizzleStudioConfig(options), "utf8");

    const child = spawn(
      process.execPath,
      [drizzleKitBin, "studio", "--config", configPath, ...passthrough],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    return await waitForExit(child);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runServe(): Promise<void> {
  const port = parsePort(process.env.FLAMECAST_PORT ?? process.env.PORT);
  const storage = await createPsqlStorage();

  const flamecast = new Flamecast({
    storage,
    runtimes: { default: new NodeRuntime() },
  });

  const server = serve({ fetch: flamecast.app.fetch, port }, () => {
    console.log(`Flamecast running on http://localhost:${port}`);
    console.log(`API: http://localhost:${port}/api`);
  });

  async function shutdown() {
    console.log("\nShutting down...");
    await flamecast.shutdown();
    server.close();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function main(args: readonly string[]): Promise<number> {
  dotenv.config({ quiet: true });

  const [command, subcommand, ...rest] = args;

  if (!command) {
    await runServe();
    return 0;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }

  if (command === "db" && subcommand === "migrate") {
    return runDbMigrate(rest);
  }

  if (command === "db" && subcommand === "studio") {
    return runDbStudio(rest);
  }

  if (command === "db") {
    throw new Error(`Unknown Flamecast db command "${subcommand ?? ""}".`);
  }

  throw new Error(`Unknown Flamecast command "${command}".`);
}
