import { dirname, resolve } from "node:path";
import { Resource, type Context } from "alchemy";
import type { Container as AlchemyContainer } from "alchemy/cloudflare";

function envRecord(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) result[key] = value;
  }
  return result;
}

/**
 * Props for the FlamecastRuntime resource.
 */
export interface FlamecastRuntimeProps {
  /** Path to the runtime-bridge entrypoint (dist/index.js). */
  bridgeEntry: string;
  /** Path to the runtime-bridge Dockerfile (for deployed mode). */
  dockerfile: string;
}

/**
 * Output of the FlamecastRuntime resource.
 */
export interface FlamecastRuntime extends FlamecastRuntimeProps {
  /** URL where the session router can be reached (local mode). */
  url?: string;
  /** CF Container binding (deployed mode) — pass as Worker binding. */
  container?: AlchemyContainer;
}

/**
 * Flamecast runtime resource.
 *
 * - **Local** (`alchemy dev`): Spawns a session router via scope.spawn.
 *   Returns `{ url: "http://localhost:<port>" }`.
 *
 * - **Deployed** (`alchemy deploy`): Creates a CF Container resource.
 *   Returns `{ container }` — pass as a Worker binding (DurableObjectNamespace).
 *   The Worker uses `getContainer(env.RUNTIME, sessionId)` to route requests.
 */
export const FlamecastRuntime = Resource(
  "flamecast::Runtime",
  async function (
    this: Context<FlamecastRuntime>,
    id: string,
    props: FlamecastRuntimeProps,
  ): Promise<FlamecastRuntime> {
    if (this.phase === "delete") {
      return this.destroy();
    }

    if (this.scope.local) {
      const bridgeEntry = resolve(props.bridgeEntry);
      const routerEntry = resolve(props.bridgeEntry, "../router.js");

      const nodeBinDir = dirname(process.execPath);
      const port = await this.scope.spawn("session-router", {
        cmd: `node ${routerEntry}`,
        env: {
          ...envRecord(),
          PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`,
          BRIDGE_ENTRY: bridgeEntry,
        },
        extract: (line) => {
          const match = line.match(/listening on port (\d+)/);
          return match ? match[1] : undefined;
        },
      });

      return {
        ...props,
        url: `http://localhost:${port}`,
      };
    }

    // Deployed mode: CF Container
    const { Container } = await import("alchemy/cloudflare");

    const container = await Container("container", {
      className: "FlamecastRuntime",
      build: {
        context: props.dockerfile.replace(/\/Dockerfile$/, ""),
        dockerfile: "Dockerfile",
      },
      maxInstances: 50,
    });

    return {
      ...props,
      container,
    };
  },
);
