import { dirname, resolve } from "node:path";
import { Resource, type Context } from "alchemy";

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
  /** URL where the session router can be reached. */
  url: string;
}

/**
 * Flamecast runtime resource.
 *
 * Returns a `url` string that the Worker receives as a binding.
 * The Worker constructs a DataPlaneBinding from this URL.
 *
 * - **Local** (`alchemy dev`): Spawns a session router via scope.spawn
 *   (idempotent, PID-tracked, auto-cleanup). The router spawns per-session
 *   bridge child processes. Returns `http://localhost:<port>`.
 *
 * - **Deployed** (`alchemy deploy`): Creates a CF Container resource.
 *   Returns the container's public URL.
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

      // Spawn session router via scope.spawn — idempotent, PID-tracked, auto-cleanup
      const nodeBinDir = dirname(process.execPath);
      const port = await this.scope.spawn("session-router", {
        cmd: `node ${routerEntry}`,
        env: {
          ...process.env as Record<string, string>,
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

    await Container("container", {
      className: "FlamecastRuntime",
      build: {
        context: props.dockerfile.replace(/\/Dockerfile$/, ""),
        dockerfile: props.dockerfile,
      },
      maxInstances: 50,
    });

    return {
      ...props,
      url: "https://placeholder.container.url",
    };
  },
);
