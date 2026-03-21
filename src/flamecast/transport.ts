import { ChildProcess, spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { createConnection, createServer } from "node:net";

function toUint8ReadableStream(
  stream: ReturnType<typeof Readable.toWeb>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const reader = stream.getReader();
      async function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          return pump();
        });
      }
      pump();
    },
  });
}

/** The ACP transport pair — SPEC §4.1. */
export type AcpTransport = {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  /** Clean up the transport and any backing resources (process, container, scope). */
  dispose?: () => Promise<void>;
};

const npxCmd = () => (process.platform === "win32" ? "npx.cmd" : "npx");

export type BuiltinAgentPreset = {
  id: string;
  label: string;
  spawn: { command: string; args: string[] };
};

/** Built-in presets; IDs are stable so clients can reference them. */
export function getBuiltinAgentProcessPresets(): BuiltinAgentPreset[] {
  const cmd = npxCmd();
  return [
    {
      id: "example",
      label: "Example agent",
      spawn: { command: cmd, args: ["tsx", "src/flamecast/agent.ts"] },
    },
    {
      id: "codex",
      label: "Codex ACP",
      spawn: { command: cmd, args: ["@zed-industries/codex-acp"] },
    },
    {
      id: "codex-docker",
      label: "Codex ACP (Docker)",
      spawn: { command: "codex-acp", args: [] },
    },
  ];
}

export function startAgentProcess(spec: { command: string; args?: string[] }): ChildProcess {
  const args = spec.args ?? [];
  return spawn(spec.command, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
}

/**
 * This allows the client to communicate with the agent process.
 * @param agentProcess - The agent process to use. Defaults to a mock agent process, but can be replaced with Claude Agent SDK, Codex, etc.
 * @returns A transport object containing the agent process, input stream, and output stream.
 */
export function openLocalTransport(spec: {
  command: string;
  args?: string[];
}): AcpTransport & { kill: () => void } {
  const agentProcess = startAgentProcess(spec);
  const { input, output } = getAgentTransport(agentProcess);
  return { input, output, kill: () => agentProcess.kill() };
}

export function getAgentTransport(agentProcess: ChildProcess) {
  // Create streams to communicate with the agent
  const stdin = agentProcess.stdin;
  const stdout = agentProcess.stdout;
  if (!stdin || !stdout) {
    throw new Error("Failed to get stdin/stdout from agent process");
  }
  const input = Writable.toWeb(stdin);
  const output = toUint8ReadableStream(Readable.toWeb(stdout));

  return {
    input,
    output,
    agentProcess,
  };
}

// ---------------------------------------------------------------------------
// TCP transport — connect to an alchemy-managed container over the network
// ---------------------------------------------------------------------------

export function openTcpTransport(host: string, port: number): Promise<AcpTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      socket.setNoDelay(true);
      // Use the same Writable.toWeb / Readable.toWeb pattern as stdio — proven to work
      const input = Writable.toWeb(socket);
      const output = toUint8ReadableStream(Readable.toWeb(socket));
      resolve({ input, output });
    });
    socket.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findFreePort(): Promise<number> {
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

export function waitForPort(host: string, port: number, timeoutMs = 30_000): Promise<void> {
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
      socket.on("error", () => setTimeout(attempt, 500));
    }
    attempt();
  });
}
