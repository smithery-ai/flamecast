import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  getDrizzleStudioConfig,
  getMigrationStatus,
  migrateDatabase,
} from "@flamecast/storage-psql";

const DRIZZLE_KIT_BIN = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("drizzle-kit"))),
  "bin.cjs",
);

export type DbFlags = {
  url?: string;
  dataDir?: string;
  host?: string;
  port?: string;
  json?: boolean;
};

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }
  return parsed;
}

function resolveStorageFlags(flags: DbFlags): { url?: string; dataDir?: string } {
  const url = flags.url ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const dataDir = flags.dataDir;

  if (url && dataDir) {
    throw new Error('Pass either "--url" or "--data-dir", not both.');
  }

  return {
    ...(url ? { url } : {}),
    ...(dataDir ? { dataDir } : {}),
  };
}

export async function runDbStatus(flags: DbFlags): Promise<number> {
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

export async function runDbMigrate(flags: DbFlags): Promise<number> {
  const bundle = await createDatabase(resolveStorageFlags(flags));

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

export async function runDbStudio(flags: DbFlags): Promise<number> {
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
