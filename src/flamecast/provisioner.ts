import Docker from "dockerode";
import { createConnection, createServer } from "node:net";
import type { AgentSpawn } from "../shared/connection.js";
import { openLocalTransport, openTcpTransport, type AcpTransport } from "./transport.js";

/**
 * SandboxHandle — JSON-serializable state that identifies a running agent.
 * Persisted alongside the connection so the orchestrator can reconnect.
 */
export type SandboxHandle = Record<string, unknown>;

/**
 * Provisioner — manages the full agent lifecycle (SPEC §4.1).
 *
 * - start: provision a new agent, return a handle + transport
 * - reconnect: re-attach to a running agent from a persisted handle
 * - destroy: tear down the agent
 */
export interface Provisioner {
  start(spec: AgentSpawn): Promise<{ handle: SandboxHandle; transport: AcpTransport }>;
  reconnect(handle: SandboxHandle): Promise<AcpTransport>;
  destroy(handle: SandboxHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local — child_process.spawn()
// ---------------------------------------------------------------------------

export class LocalProvisioner implements Provisioner {
  async start(spec: AgentSpawn): Promise<{ handle: SandboxHandle; transport: AcpTransport }> {
    const transport = openLocalTransport(spec);
    // Local processes can't be reconnected — handle stores the spec for reference
    return { handle: { type: "local", spec }, transport };
  }

  async reconnect(_handle: SandboxHandle): Promise<AcpTransport> {
    throw new Error("LocalProvisioner does not support reconnect");
  }

  async destroy(_handle: SandboxHandle): Promise<void> {
    // Transport dispose already kills the process
  }
}

// ---------------------------------------------------------------------------
// Remote — connect to an already-running agent via TCP
// ---------------------------------------------------------------------------

export class RemoteProvisioner implements Provisioner {
  constructor(
    private host: string,
    private port: number,
  ) {}

  async start(_spec: AgentSpawn): Promise<{ handle: SandboxHandle; transport: AcpTransport }> {
    const transport = await openTcpTransport(this.host, this.port);
    return { handle: { type: "remote", host: this.host, port: this.port }, transport };
  }

  async reconnect(handle: SandboxHandle): Promise<AcpTransport> {
    return openTcpTransport(String(handle.host), Number(handle.port));
  }

  async destroy(_handle: SandboxHandle): Promise<void> {
    // Remote agents are externally managed — nothing to destroy
  }
}

// ---------------------------------------------------------------------------
// Docker — container per-connection, connect via TCP, tear down on destroy
// ---------------------------------------------------------------------------

const docker = new Docker();

export interface DockerProvisionerConfig {
  /** Pre-built image ref (managed by alchemy). */
  image: string;
  /** Docker network to attach to (managed by alchemy). */
  network?: string;
  /** Memory limit in bytes. */
  memory?: number;
  /** CPU quota in NanoCPUs (1e9 = 1 CPU). */
  nanoCpus?: number;
}

export class DockerProvisioner implements Provisioner {
  constructor(private config: DockerProvisionerConfig) {}

  async start(_spec: AgentSpawn): Promise<{ handle: SandboxHandle; transport: AcpTransport }> {
    const port = await findFreePort();

    const container = await docker.createContainer({
      Image: this.config.image,
      Env: [`ACP_PORT=${port}`],
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        NetworkMode: this.config.network,
        Memory: this.config.memory,
        NanoCpus: this.config.nanoCpus,
        PortBindings: { [`${port}/tcp`]: [{ HostPort: String(port) }] },
      },
    });

    await container.start();
    const info = await container.inspect();
    await waitForPort("localhost", port, 30_000);

    const transport = await openTcpTransport("localhost", port);
    const handle: SandboxHandle = {
      type: "docker",
      containerId: info.Id,
      host: "localhost",
      port,
    };

    return { handle, transport };
  }

  async reconnect(handle: SandboxHandle): Promise<AcpTransport> {
    return openTcpTransport(String(handle.host), Number(handle.port));
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const containerId = String(handle.containerId || "");
    if (!containerId) return;
    const container = docker.getContainer(containerId);
    try {
      await container.stop({ t: 2 });
    } catch {
      // May already be stopped
    }
    try {
      await container.remove({ force: true });
    } catch {
      // May already be removed
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        return;
      }
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}
