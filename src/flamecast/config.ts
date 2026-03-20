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
 * Provisioner — a function that creates an agent and returns an AcpTransport.
 * Called inside a per-connection Alchemy scope.
 *
 * The provisioner can create Alchemy resources (docker.Container, etc.) inside
 * the scope — those get lifecycle-managed automatically. The transport itself
 * is ephemeral (not persisted). Alchemy persists the resource state (container ID,
 * etc.) for reconnection; the transport is recreated from that state.
 */
export type Provisioner = (
  connectionId: string,
  spec: import("../shared/connection.js").AgentSpawn,
) => Promise<import("./transport.js").AcpTransport>;

export type FlamecastOptions = {
  stateManager?: StateManagerConfig; // default: { type: "pglite" }
  /** Provisioner that creates agents and returns an AcpTransport. Defaults to local ChildProcess. */
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
// Built-in provisioner: local ChildProcess as an Alchemy Resource
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Flamecast instance from config options.
 * Resolves state manager, initializes Alchemy.
 */
export async function createFlamecast(opts: FlamecastOptions = {}): Promise<Flamecast> {
  const stateManager = await resolveStateManager(opts.stateManager);

  const scope = await alchemy("flamecast", { phase: "up", stage: opts.stage, quiet: true });

  // Default provisioner: local ChildProcess via stdio
  const provisioner: Provisioner =
    opts.provisioner ??
    (async (_connectionId, spec) => {
      const { openLocalTransport } = await import("./transport.js");
      return openLocalTransport(spec);
    });

  return new Flamecast({ stateManager, provisioner, alchemyScope: scope });
}
