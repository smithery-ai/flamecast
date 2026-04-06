import type { Flamecast } from "./flamecast/index.js";
import type { FlamecastStorage } from "@flamecast/protocol";
import { createPsqlStorage } from "@flamecast/storage-psql";
import type { PsqlConnectionOptions, PsqlDatabase } from "@flamecast/storage-psql";

export type FlamecastDbConfig = PsqlConnectionOptions | PsqlDatabase;
export type FlamecastAppFactoryContext = {
  db: FlamecastDbConfig;
  storage: FlamecastStorage;
};
export type FlamecastAppFactory = (
  context: FlamecastAppFactoryContext,
) => Promise<Flamecast> | Flamecast;
export type FlamecastConfig = {
  db: FlamecastDbConfig;
  createFlamecast?: FlamecastAppFactory;
};

export type FlamecastAppConfig = FlamecastConfig & {
  createFlamecast: FlamecastAppFactory;
};

function isPsqlDatabase(value: FlamecastDbConfig): value is PsqlDatabase {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "psql" &&
    "createStorage" in value &&
    typeof value.createStorage === "function"
  );
}

export function defineConfig<const T extends FlamecastConfig>(config: T): T {
  return config;
}

async function resolveStorage(config: FlamecastDbConfig): Promise<FlamecastStorage> {
  if (isPsqlDatabase(config)) {
    return config.createStorage();
  }

  return createPsqlStorage(config);
}

export async function createFlamecastFromConfig(config: FlamecastAppConfig): Promise<Flamecast> {
  const storage = await resolveStorage(config.db);
  return config.createFlamecast({
    db: config.db,
    storage,
  });
}
