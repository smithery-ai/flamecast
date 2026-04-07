import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import {
  assertDatabaseReady,
  createDatabase,
  createStorageFromDb,
  defaultAgentTemplates,
  getDrizzleStudioConfig,
  getMigrationStatus,
  migrateDatabase,
} from "@flamecast/storage-psql";
import { Flamecast, NodeRuntime } from "./index.js";

const require = createRequire(import.meta.url);
const DRIZZLE_KIT_BIN = path.join(path.dirname(require.resolve("drizzle-kit")), "bin.cjs");

type Command =
  | {
      kind: "help";
    }
  | {
      kind: "serve";
      flags: CliFlags;
    }
  | {
      kind: "db-status";
      flags: CliFlags;
    }
  | {
      kind: "db-migrate";
      flags: CliFlags;
    }
  | {
      kind: "db-studio";
      flags: CliFlags;
    };

type CliFlags = {
  url?: string;
  dataDir?: string;
  host?: string;
  port?: string;
  json?: boolean;
};

function printHelp(): void {
  console.log(`Usage:
  flamecast serve [--url <postgres-url>] [--data-dir <path>] [--port <port>]
  flamecast db status [--url <postgres-url>] [--data-dir <path>] [--json]
  flamecast db migrate [--url <postgres-url>] [--data-dir <path>]
  flamecast db studio [--url <postgres-url>] [--data-dir <path>] [--host <host>] [--port <port>]

Environment:
  DATABASE_URL or POSTGRES_URL  Postgres connection string
  FLAMECAST_PGLITE_DIR          Override the default PGLite data directory
  FLAMECAST_PORT or PORT        Default serve port (3001)
`);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }
  return parsed;
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}"`);
    }

    if (arg === "--json") {
      flags.json = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for "${arg}"`);
    }

    if (arg === "--url") {
      flags.url = value;
    } else if (arg === "--data-dir") {
      flags.dataDir = value;
    } else if (arg === "--host") {
      flags.host = value;
    } else if (arg === "--port") {
      flags.port = value;
    } else {
      throw new Error(`Unknown flag "${arg}"`);
    }

    index += 1;
  }

  return flags;
}

function resolveStorageFlags(flags: CliFlags): { url?: string; dataDir?: string } {
  const url = flags.url ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const dataDir = flags.dataDir;

  if (url && dataDir) {
    throw new Error('Pass either "--url" or "--data-dir", not both.');
  }

  if (!url && !dataDir) {
    console.warn("No DATABASE_URL, POSTGRES_URL, or --url provided; defaulting to local PGlite.");
  }

  return {
    ...(url ? { url } : {}),
    ...(dataDir ? { dataDir } : {}),
  };
}

export function parseCliArgs(argv: string[]): Command {
  if (argv.length === 0) {
    return {
      kind: "serve",
      flags: {},
    };
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    return { kind: "help" };
  }

  const [first, second, ...rest] = argv;

  if (first === "serve") {
    return {
      kind: "serve",
      flags: parseFlags([second, ...rest].filter((value): value is string => value !== undefined)),
    };
  }

  if (first === "db") {
    if (!second) {
      throw new Error('Missing db subcommand. Expected "status", "migrate", or "studio".');
    }

    if (second === "status") {
      return {
        kind: "db-status",
        flags: parseFlags(rest),
      };
    }

    if (second === "migrate") {
      return {
        kind: "db-migrate",
        flags: parseFlags(rest),
      };
    }

    if (second === "studio") {
      return {
        kind: "db-studio",
        flags: parseFlags(rest),
      };
    }

    throw new Error(`Unknown db subcommand "${second}"`);
  }

  throw new Error(`Unknown command "${first}"`);
}

async function runServeCommand(flags: CliFlags): Promise<number> {
  const port = parsePort(flags.port ?? process.env.FLAMECAST_PORT ?? process.env.PORT, 3001);
  const storageOptions = resolveStorageFlags(flags);
  const bundle = await createDatabase(storageOptions);

  try {
    await assertDatabaseReady(bundle);

    const storage = createStorageFromDb(bundle.db);
    if (storageOptions.url === undefined) {
      await storage.seedAgentTemplates(defaultAgentTemplates);
    }

    const flamecast = new Flamecast({
      storage,
      runtimes: { default: new NodeRuntime() },
    });

    const server = serve({ fetch: flamecast.app.fetch, port }, () => {
      console.log(`Flamecast running on http://localhost:${port}`);
      console.log(`API: http://localhost:${port}/api`);
    });

    return await new Promise<number>((resolve) => {
      let shuttingDown = false;

      async function shutdown(): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        let exitCode = 0;

        console.log("\nShutting down...");
        try {
          await flamecast.shutdown();
          await new Promise<void>((closeResolve) => {
            server.close(() => {
              closeResolve();
            });
          });
        } catch (error) {
          exitCode = 1;
          console.error(error instanceof Error ? error.message : String(error));
        } finally {
          await bundle.close().catch(() => {});
          resolve(exitCode);
        }
      }

      process.on("SIGTERM", () => {
        void shutdown();
      });
      process.on("SIGINT", () => {
        void shutdown();
      });
    });
  } catch (error) {
    await bundle.close().catch(() => {});
    throw error;
  }
}

async function runStatusCommand(flags: CliFlags): Promise<number> {
  const bundle = await createDatabase(resolveStorageFlags(flags));

  try {
    const status = await getMigrationStatus(bundle);
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
    } else if (status.isUpToDate) {
      console.log(
        status.current
          ? `Database schema is up to date at ${status.current.tag}.`
          : "Database schema has no pending migrations.",
      );
    } else {
      console.log(`Pending migrations: ${status.pending.map((record) => record.tag).join(", ")}`);
    }

    return status.isUpToDate ? 0 : 2;
  } finally {
    await bundle.close();
  }
}

async function runMigrateCommand(flags: CliFlags): Promise<number> {
  const bundle = await createDatabase(resolveStorageFlags(flags));

  try {
    if (bundle.driver === "postgres") {
      const host = new URL(bundle.url).hostname;
      console.log(`Migrating database on ${host}`);
    } else {
      console.log(`Migrating local PGlite database at ${bundle.dataDir}`);
    }

    const { applied, status } = await migrateDatabase(bundle);
    if (applied.length === 0) {
      console.log(
        status.current
          ? `Database already up to date at ${status.current.tag}.`
          : "Database already up to date.",
      );
      return 0;
    }

    console.log(`Applied migrations: ${applied.map((record) => record.tag).join(", ")}`);
    return 0;
  } finally {
    await bundle.close();
  }
}

async function runStudioCommand(flags: CliFlags): Promise<number> {
  const config = getDrizzleStudioConfig(resolveStorageFlags(flags));
  const tempDir = await mkdtemp(path.join(tmpdir(), "flamecast-drizzle-studio-"));
  const configPath = path.join(tempDir, "drizzle.studio.config.mjs");
  const host = flags.host ?? "0.0.0.0";
  const port = String(parsePort(flags.port, 4983));
  const configContents = `export default ${JSON.stringify(config, null, 2)};\n`;

  await writeFile(configPath, configContents, { mode: 0o600 });

  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [DRIZZLE_KIT_BIN, "studio", "--config", configPath, "--host", host, "--port", port],
        {
          stdio: "inherit",
        },
      );

      child.on("error", (error) => {
        reject(error);
      });
      child.on("exit", (code, signal) => {
        if (signal) {
          resolve(1);
          return;
        }

        resolve(code ?? 0);
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const command = parseCliArgs(argv);

  if (command.kind === "help") {
    printHelp();
    return 0;
  }

  if (command.kind === "serve") {
    return runServeCommand(command.flags);
  }

  if (command.kind === "db-status") {
    return runStatusCommand(command.flags);
  }

  if (command.kind === "db-migrate") {
    return runMigrateCommand(command.flags);
  }

  return runStudioCommand(command.flags);
}
