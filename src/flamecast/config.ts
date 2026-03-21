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
  runtime: import("./presets.js").AgentRuntime,
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
// Default provisioner — uses runtime from preset to decide local vs Docker
// ---------------------------------------------------------------------------

const defaultProvisioner: Provisioner = async (connectionId, spec, runtime) => {
  if (runtime.type === "local") {
    const { openLocalTransport } = await import("./transport.js");
    return openLocalTransport(spec);
  }

  // Non-local runtimes use alchemy/{type} provider
  const provider = await import(`alchemy/${runtime.type}`);
  const { findFreePort, waitForPort, openTcpTransport } = await import("./transport.js");
  const port = await findFreePort();

  // Build image if dockerfile is provided
  if (runtime.image && runtime.dockerfile) {
    await provider.Image(`agent-image-${connectionId}`, {
      name: runtime.image,
      tag: "latest",
      build: { context: ".", dockerfile: runtime.dockerfile },
      skipPush: true,
    });
  }

  await provider.Container(`sandbox-${connectionId}`, {
    image: `${runtime.image}:latest`,
    name: `flamecast-sandbox-${connectionId}`,
    environment: { ACP_PORT: String(port) },
    ports: [{ external: port, internal: port }],
    start: true,
  });

  await waitForPort("localhost", port);
  await new Promise((r) => setTimeout(r, 1000));

  return openTcpTransport("localhost", port);
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createFlamecast(opts: FlamecastOptions = {}): Promise<Flamecast> {
  const stateManager = await resolveStateManager(opts.stateManager);

  const provisioner: Provisioner = opts.provisioner ?? defaultProvisioner;

  const { getBuiltinAgentPresets } = await import("./presets.js");
  const presets = getBuiltinAgentPresets();

  return new Flamecast({ stateManager, provisioner, presets });
}
