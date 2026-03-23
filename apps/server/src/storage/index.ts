import type { FlamecastStorage } from "@flamecast/sdk";
import { createDatabase } from "./db/client.js";
import { createPsqlStorage } from "./psql/index.js";

export type ServerStorageConfig =
  | "pglite"
  | { type: "pglite"; dataDir?: string }
  | { type: "postgres"; url: string }
  | FlamecastStorage;

export async function createServerStorage(config?: ServerStorageConfig): Promise<FlamecastStorage> {
  if (!config || config === "pglite") {
    const { db } = await createDatabase();
    return createPsqlStorage(db);
  }

  if (typeof config === "object" && "type" in config) {
    switch (config.type) {
      case "pglite": {
        const { db } = await createDatabase({ pgliteDataDir: config.dataDir });
        return createPsqlStorage(db);
      }
      case "postgres": {
        process.env.FLAMECAST_POSTGRES_URL = config.url;
        const { db } = await createDatabase();
        return createPsqlStorage(db);
      }
    }
  }

  return config;
}
