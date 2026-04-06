import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  assertDatabaseReady,
  createDatabase,
  createStorageFromDb,
  defaultAgentTemplates,
  getDrizzleStudioConfig,
  getMigrationStatus,
  migrateDatabase,
  type PsqlConnectionOptions,
  type PsqlDatabase,
} from "@flamecast/storage-psql";
import { tsImport } from "tsx/esm/api";
import { Flamecast, NodeRuntime } from "./index.js";
import type { FlamecastConfig, FlamecastDbConfig } from "./config.js";

const require = createRequire(import.meta.url);
const DRIZZLE_KIT_BIN = path.join(path.dirname(require.resolve("drizzle-kit")), "bin.cjs");
const DEFAULT_CONFIG_FILES = [
  "flamecast.config.ts",
  "flamecast.config.mts",
  "flamecast.config.js",
  "flamecast.config.mjs",
  "flamecast.config.cts",
  "flamecast.config.cjs",
];

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
  config?: string;
  host?: string;
  port?: string;
  json?: boolean;
};

function printHelp(): void {
  console.log(`Usage:
  flamecast serve [--config <path>] [--url <postgres-url>] [--data-dir <path>] [--port <port>]
  flamecast db status [--config <path>] [--url <postgres-url>] [--data-dir <path>] [--json]
  flamecast db migrate [--config <path>] [--url <postgres-url>] [--data-dir <path>]
  flamecast db studio [--config <path>] [--url <postgres-url>] [--data-dir <path>] [--host <host>] [--port <port>]

Environment:
  DATABASE_URL or POSTGRES_URL  Postgres connection string (used when no config file is found)
  FLAMECAST_PGLITE_DIR          Override the default PGLite data directory
  FLAMECAST_PORT or PORT        Default serve port (3001)

Config discovery:
  flamecast.config.ts|mts|js|mjs|cts|cjs  Configured Flamecast instance or legacy db config loaded from the cwd
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
    } else if (arg === "--config") {
      flags.config = value;
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

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function toPsqlConnectionOptions(value: unknown): { url?: string; dataDir?: string } | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const url = Reflect.get(value, "url");
  const dataDir = Reflect.get(value, "dataDir");
  if (
    (typeof url !== "string" && url !== undefined) ||
    (typeof dataDir !== "string" && dataDir !== undefined)
  ) {
    return undefined;
  }

  return {
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof dataDir === "string" ? { dataDir } : {}),
  };
}

function isPsqlDatabase(value: unknown): value is PsqlDatabase {
  return (
    isObject(value) &&
    Reflect.get(value, "kind") === "psql" &&
    typeof Reflect.get(value, "open") === "function" &&
    typeof Reflect.get(value, "createStorage") === "function" &&
    typeof Reflect.get(value, "getMigrationStatus") === "function" &&
    typeof Reflect.get(value, "migrate") === "function" &&
    typeof Reflect.get(value, "getStudioConfig") === "function"
  );
}

function isFlamecastInstance(value: unknown): value is Flamecast {
  if (!isObject(value)) {
    return false;
  }

  const app = Reflect.get(value, "app");
  return (
    isObject(app) &&
    typeof Reflect.get(app, "fetch") === "function" &&
    typeof Reflect.get(value, "init") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "shutdown") === "function" &&
    typeof Reflect.get(value, "migrate") === "function" &&
    typeof Reflect.get(value, "getMigrationStatus") === "function" &&
    typeof Reflect.get(value, "getStudioConfig") === "function"
  );
}

function toFlamecastConfig(value: unknown): FlamecastConfig | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const rawDb = Reflect.get(value, "db");
  const db = isPsqlDatabase(rawDb) ? rawDb : toPsqlConnectionOptions(rawDb);
  if (!db) {
    return undefined;
  }

  return { db };
}

function readFlamecastConfig(moduleNamespace: unknown): FlamecastConfig | undefined {
  const pending: unknown[] = [moduleNamespace];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const config = toFlamecastConfig(candidate);
    if (config) {
      return config;
    }

    if (isObject(candidate)) {
      pending.push(
        Reflect.get(candidate, "default"),
        Reflect.get(candidate, "flamecastConfig"),
        Reflect.get(candidate, "config"),
      );
    }
  }

  return undefined;
}

function readConfiguredFlamecast(moduleNamespace: unknown): Flamecast | undefined {
  const pending: unknown[] = [moduleNamespace];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (isFlamecastInstance(candidate)) {
      return candidate;
    }

    if (isObject(candidate)) {
      pending.push(
        Reflect.get(candidate, "default"),
        Reflect.get(candidate, "flamecast"),
        Reflect.get(candidate, "app"),
        Reflect.get(candidate, "config"),
      );
    }
  }

  return undefined;
}

async function resolveConfigPath(
  flags: CliFlags,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (flags.config) {
    const resolved = path.isAbsolute(flags.config) ? flags.config : path.resolve(cwd, flags.config);
    try {
      await access(resolved);
      return resolved;
    } catch {
      throw new Error(`Flamecast config file not found: ${resolved}`);
    }
  }

  for (const fileName of DEFAULT_CONFIG_FILES) {
    const candidate = path.join(cwd, fileName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

async function loadFlamecastConfig(
  flags: CliFlags,
  cwd = process.cwd(),
): Promise<FlamecastConfig | undefined> {
  const configPath = await resolveConfigPath(flags, cwd);
  if (!configPath) {
    return undefined;
  }

  const moduleNamespace = await tsImport(pathToFileURL(configPath).href, {
    parentURL: import.meta.url,
  });
  const flamecast = readConfiguredFlamecast(moduleNamespace);
  if (flamecast) {
    return undefined;
  }
  const config = readFlamecastConfig(moduleNamespace);
  if (!config) {
    throw new Error(
      `Flamecast config "${configPath}" must export either a Flamecast instance or defineConfig({ db: createPsqlDatabase(...) }) / defineConfig({ db: { ... } }) as default or as "flamecastConfig".`,
    );
  }

  return config;
}

async function loadConfiguredFlamecast(
  flags: CliFlags,
  cwd = process.cwd(),
): Promise<Flamecast | undefined> {
  const configPath = await resolveConfigPath(flags, cwd);
  if (!configPath) {
    return undefined;
  }

  const moduleNamespace = await tsImport(pathToFileURL(configPath).href, {
    parentURL: import.meta.url,
  });
  return readConfiguredFlamecast(moduleNamespace);
}

export type ResolvedDatabaseSource =
  | {
      kind: "options";
      db: PsqlConnectionOptions;
    }
  | {
      kind: "script";
      db: PsqlDatabase;
    };

function toDatabaseSource(db: FlamecastDbConfig): ResolvedDatabaseSource {
  if (isPsqlDatabase(db)) {
    return {
      kind: "script",
      db,
    };
  }

  return {
    kind: "options",
    db,
  };
}

export type ResolvedCliTarget =
  | {
      kind: "flamecast";
      flamecast: Flamecast;
    }
  | {
      kind: "database";
      source: ResolvedDatabaseSource;
    };

export async function resolveDatabaseSource(
  flags: CliFlags,
  cwd = process.cwd(),
): Promise<ResolvedDatabaseSource> {
  if (flags.url && flags.dataDir) {
    throw new Error('Pass either "--url" or "--data-dir", not both.');
  }

  if (flags.url || flags.dataDir) {
    return {
      kind: "options",
      db: {
        ...(flags.url ? { url: flags.url } : {}),
        ...(flags.dataDir ? { dataDir: flags.dataDir } : {}),
      },
    };
  }

  const config = await loadFlamecastConfig(flags, cwd);
  if (config) {
    return toDatabaseSource(config.db);
  }

  const envUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  return {
    kind: "options",
    db: {
      ...(envUrl ? { url: envUrl } : {}),
    },
  };
}

export async function resolveCliTarget(
  flags: CliFlags,
  cwd = process.cwd(),
): Promise<ResolvedCliTarget> {
  if (!flags.url && !flags.dataDir) {
    const flamecast = await loadConfiguredFlamecast(flags, cwd);
    if (flamecast) {
      return {
        kind: "flamecast",
        flamecast,
      };
    }
  }

  return {
    kind: "database",
    source: await resolveDatabaseSource(flags, cwd),
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
  const target = await resolveCliTarget(flags);
  if (target.kind === "flamecast") {
    const flamecast = target.flamecast;
    await flamecast.init();

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
  }

  const dbSource = target.source;
  const bundle =
    dbSource.kind === "script" ? await dbSource.db.open() : await createDatabase(dbSource.db);

  try {
    await assertDatabaseReady(bundle);

    const storage = createStorageFromDb(bundle.db);
    if (bundle.driver === "pglite") {
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
  const target = await resolveCliTarget(flags);
  if (target.kind === "flamecast") {
    const status = await target.flamecast.getMigrationStatus();
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
  }

  const dbSource = target.source;
  if (dbSource.kind === "script") {
    const status = await dbSource.db.getMigrationStatus();
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
  }

  const bundle = await createDatabase(dbSource.db);

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
  const target = await resolveCliTarget(flags);
  if (target.kind === "flamecast") {
    const { applied, status } = await target.flamecast.migrate();
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
  }

  const dbSource = target.source;
  if (dbSource.kind === "script") {
    const { applied, status } = await dbSource.db.migrate();
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
  }

  const bundle = await createDatabase(dbSource.db);

  try {
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
  const target = await resolveCliTarget(flags);
  if (target.kind === "flamecast") {
    return runStudioWithConfig(await target.flamecast.getStudioConfig(), flags);
  }

  const dbSource = target.source;
  const config =
    dbSource.kind === "script"
      ? dbSource.db.getStudioConfig()
      : getDrizzleStudioConfig(dbSource.db);
  return runStudioWithConfig(config, flags);
}

async function runStudioWithConfig(config: unknown, flags: CliFlags): Promise<number> {
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
