import alchemy from "alchemy";
import type { FlamecastStateManager } from "./state-manager.js";
import { MemoryFlamecastStateManager } from "./state-managers/memory/index.js";
import { Flamecast } from "./index.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type StateManagerConfig =
  | { type: "memory" }
  | { type: "pglite"; dataDir?: string }
  | { type: "postgres"; url: string }
  | FlamecastStateManager; // pass your own implementation

/**
 * An Alchemy Resource that provisions an agent sandbox.
 * Called with (connectionId) inside a per-connection Alchemy scope.
 * Must return { host, port } so Flamecast can open a TCP transport.
 * Alchemy handles create/update/delete lifecycle automatically.
 *
 * Omit for local ChildProcess (no Alchemy, no scope).
 */
export type Provisioner = (connectionId: string) => Promise<{ host: string; port: number }>;

export type FlamecastOptions = {
  stateManager?: StateManagerConfig; // default: { type: "pglite" }
  /** Alchemy Resource that provisions agent sandboxes. Omit for local ChildProcess. */
  provisioner?: Provisioner;

  /** Alchemy stage for resource isolation. Defaults to $USER. */
  stage?: string;
};

// ---------------------------------------------------------------------------
// Config → instance resolvers
// ---------------------------------------------------------------------------

async function resolveStateManager(config?: StateManagerConfig): Promise<FlamecastStateManager> {
  if (!config || (typeof config === "object" && "type" in config && config.type === "pglite")) {
    const { createDatabase } = await import("./db/client.js");
    const { db } = await createDatabase(
      typeof config === "object" && "dataDir" in config ? { pgliteDataDir: config.dataDir } : {},
    );
    const { createPsqlStateManager } = await import("./state-managers/psql/index.js");
    return createPsqlStateManager(db);
  }
  if (typeof config === "object" && "type" in config) {
    switch (config.type) {
      case "memory":
        return new MemoryFlamecastStateManager();
      case "postgres": {
        const { createDatabase } = await import("./db/client.js");
        process.env.FLAMECAST_POSTGRES_URL = config.url;
        const { db } = await createDatabase();
        const { createPsqlStateManager } = await import("./state-managers/psql/index.js");
        return createPsqlStateManager(db);
      }
    }
  }
  // It's a FlamecastStateManager instance
  return config;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Flamecast instance from config options.
 * Resolves state manager, initializes Alchemy when a provisioner is provided.
 */
export async function createFlamecast(opts: FlamecastOptions = {}): Promise<Flamecast> {
  const stateManager = await resolveStateManager(opts.stateManager);

  // Initialize Alchemy when a provisioner needs it for scope-based lifecycle.
  if (opts.provisioner) {
    await alchemy("flamecast", { stage: opts.stage });
  }

  return new Flamecast({
    stateManager,
    provisioner: opts.provisioner,
  });
}
