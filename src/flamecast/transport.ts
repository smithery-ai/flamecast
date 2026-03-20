import { ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";
import { createConnection } from "node:net";

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
};

const npxCmd = () => (process.platform === "win32" ? "npx.cmd" : "npx");

export type BuiltinAgentPreset = {
  id: string;
  label: string;
  spawn: { command: string; args: string[] };
};

/** Built-in presets; IDs are stable so clients can reference them. */
export function getBuiltinAgentProcessPresets(): BuiltinAgentPreset[] {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const agentPath = join(__dirname, "agent.ts");
  const cmd = npxCmd();
  return [
    {
      id: "example",
      label: "Example agent (tsx)",
      spawn: { command: cmd, args: ["tsx", agentPath] },
    },
    {
      id: "codex",
      label: "Codex ACP",
      spawn: { command: cmd, args: ["@zed-industries/codex-acp"] },
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
      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise((res, rej) => {
            socket.write(chunk, (err) => (err ? rej(err) : res()));
          });
        },
        close() {
          socket.end();
        },
      });

      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          socket.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          socket.on("end", () => controller.close());
          socket.on("error", (err) => controller.error(err));
        },
      });

      resolve({ input, output });
    });
    socket.on("error", reject);
  });
}
