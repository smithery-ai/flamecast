import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Convert process.env to Record<string, string> without type assertion. */
function envRecord(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) result[key] = value;
  }
  return result;
}
import alchemy, { Resource, Secret, type Context } from "alchemy";
import { Hyperdrive } from "alchemy/cloudflare";
import { Exec } from "alchemy/os";

/**
 * Props for the FlamecastDatabase resource.
 */
export interface FlamecastDatabaseProps {
  /** PGLite data directory (local mode only). Defaults to .flamecast/pglite */
  dataDir?: string;
}

/**
 * Output of the FlamecastDatabase resource.
 */
export interface FlamecastDatabase extends FlamecastDatabaseProps {
  /** Hyperdrive binding for the Worker. */
  binding: Awaited<ReturnType<typeof Hyperdrive>>;
  /** Raw connection string (for Exec migrations, not Worker use). */
  connectionString: string;
}

/**
 * Flamecast database resource.
 *
 * - **Local** (`alchemy dev`): Spawns pglite-server via scope.spawn
 *   (idempotent, PID-tracked, auto-respawn on restart via idempotentSpawn).
 *   Creates Hyperdrive with dev.origin pointing at the local pglite-server port.
 * - **Deployed** (`alchemy deploy`): Provisions Neon PostgreSQL, creates
 *   Hyperdrive with origin pointing at Neon.
 *
 * Migrations run via Exec at provision time (Node.js process with
 * filesystem access), never inside the Worker.
 */
export const FlamecastDatabase = Resource(
  "flamecast::Database",
  async function (
    this: Context<FlamecastDatabase>,
    id: string,
    props: FlamecastDatabaseProps,
  ): Promise<FlamecastDatabase> {
    if (this.phase === "delete") {
      return this.destroy();
    }

    let connectionString: string;

    if (this.scope.local) {
      const dataDir = resolve(props.dataDir ?? ".flamecast/pglite");
      await mkdir(dataDir, { recursive: true });

      // scope.spawn uses idempotentSpawn — persists PID to state file,
      // checks liveness on restart, respawns if dead. Handles alchemy dev
      // restart correctly without nuking .alchemy/ state.
      const nodeBinDir = dirname(process.execPath);
      const port = await this.scope.spawn("pglite-server", {
        cmd: `npx pglite-server --db ${dataDir} --port 0 --max-connections 5`,
        env: { ...envRecord(), PATH: `${nodeBinDir}:${process.env.PATH ?? ""}` },
        extract: (line) => {
          const match = line.match(/"port"\s*:\s*(\d+)/);
          return match ? match[1] : undefined;
        },
      });

      connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    } else {
      // Deployed mode: Neon PostgreSQL
      const { NeonProject, NeonBranch } = await import("alchemy/neon");

      const project = await NeonProject("db", {
        adopt: true,
        name: `flamecast-${this.scope.stage}`,
        region_id: "aws-us-east-1",
        pg_version: 16,
        apiKey: alchemy.secret.env.NEON_API_KEY,
      });

      const branch = await NeonBranch("branch", {
        adopt: true,
        project,
        name: this.scope.stage,
        endpoints: [{ type: "read_write" }],
      });

      // Extract connection string from branch connection URIs
      const uri = branch.connectionUris[0];
      if (!uri) throw new Error("No connection URI returned from Neon branch");
      connectionString = Secret.unwrap(uri.connection_uri);
    }

    // Run migrations at provision time
    await Exec("migrate", {
      command: "pnpm --filter @flamecast/storage-psql db:migrate",
      env: { DATABASE_URL: connectionString },
      memoize: false,
    });

    // Seed builtin agent templates
    await Exec("seed", {
      command: "pnpm --filter @flamecast/storage-psql db:seed",
      env: { DATABASE_URL: connectionString },
      memoize: false,
    });

    // Hyperdrive handles Worker ↔ database connections in both modes
    const hyperdrive = await Hyperdrive("db-hyperdrive", {
      origin: connectionString,
      dev: {
        origin: connectionString,
      },
      caching: { disabled: true },
    });

    return {
      ...props,
      binding: hyperdrive,
      connectionString,
    };
  },
);
