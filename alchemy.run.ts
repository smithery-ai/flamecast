import alchemy from "alchemy";
import * as docker from "alchemy/docker";
import path from "node:path";

const app = await alchemy("flamecast");

const stack = app.stage;

/** ACP port inside containers — agents listen on this via ACP_PORT env var. */
const ACP_PORT = 9100;

// Isolated network for agent containers
const network = await docker.Network("agent-network", {
  name: `flamecast-agents-${stack}`,
  driver: "bridge",
});

// Build the example agent image
const exampleAgentImage = await docker.Image("example-agent-image", {
  name: "flamecast/example-agent",
  tag: stack,
  build: {
    context: ".",
    dockerfile: "docker/example-agent.Dockerfile",
  },
  skipPush: true,
});

// Shared workspace volume — mounted into agent containers for filesystem access
const workspace = await docker.Volume("workspace", {
  name: `flamecast-workspace-${stack}`,
  adopt: true,
});

// Run the example agent container — listens on ACP_PORT for TCP connections
const exampleAgent = await docker.Container("example-agent", {
  image: exampleAgentImage,
  name: `flamecast-example-${stack}`,
  networks: [{ name: network.name }],
  environment: { ACP_PORT: String(ACP_PORT) },
  ports: [{ external: ACP_PORT, internal: ACP_PORT }],
  volumes: [{ hostPath: path.resolve("workspace"), containerPath: "/workspace" }],
  start: true,
});

await app.finalize();

export { network, exampleAgentImage, exampleAgent, workspace };
