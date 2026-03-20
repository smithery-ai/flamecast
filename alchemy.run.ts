import alchemy from "alchemy";
import * as docker from "alchemy/docker";

const app = await alchemy("flamecast");

const stack = app.stage;

/** ACP port inside containers — agents listen on this via ACP_PORT env var. */
const ACP_PORT = 9100;

// ---------------------------------------------------------------------------
// Network — all containers (agents + services) share this
// ---------------------------------------------------------------------------

const network = await docker.Network("agent-network", {
  name: `flamecast-agents-${stack}`,
  driver: "bridge",
});

// ---------------------------------------------------------------------------
// Agent: example
// ---------------------------------------------------------------------------

const exampleAgentImage = await docker.Image("example-agent-image", {
  name: "flamecast/example-agent",
  tag: stack,
  build: {
    context: ".",
    dockerfile: "docker/example-agent.Dockerfile",
  },
  skipPush: true,
});

const exampleAgent = await docker.Container("example-agent", {
  image: exampleAgentImage,
  name: `flamecast-example-${stack}`,
  networks: [{ name: network.name }],
  environment: { ACP_PORT: String(ACP_PORT) },
  ports: [{ external: ACP_PORT, internal: ACP_PORT }],
  start: true,
});

// ---------------------------------------------------------------------------
// Convex (self-hosted) — durable projection store (SPEC Phase 2/3)
//
// Uncomment when ready to integrate the Projection interface.
// The Convex backend runs on the same network so agents never talk to it
// directly — only Flamecast does, via the persistence port (SPEC §2.5).
// ---------------------------------------------------------------------------

// const convexImage = await docker.RemoteImage("convex-image", {
//   name: "ghcr.io/get-convex/convex-backend",
//   tag: "latest",
// });
//
// const convex = await docker.Container("convex", {
//   image: convexImage,
//   name: `flamecast-convex-${stack}`,
//   networks: [{ name: network.name }],
//   ports: [{ external: 3210, internal: 3210 }],
//   volumes: [
//     { hostPath: `./data/convex-${stack}`, containerPath: "/convex/data" },
//   ],
//   start: true,
// });

await app.finalize();

export { network, exampleAgentImage, exampleAgent };
