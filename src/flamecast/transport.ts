import { ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";

/** The ACP transport pair — spec §2.4. */
export interface AcpTransport {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Web Stream helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Local transport — ChildProcess stdio
// ---------------------------------------------------------------------------

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

export function openLocalTransport(spec: { command: string; args?: string[] }): AcpTransport {
  const agentProcess: ChildProcess = spawn(spec.command, spec.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stdin = agentProcess.stdin;
  const stdout = agentProcess.stdout;
  if (!stdin || !stdout) {
    throw new Error("Failed to get stdin/stdout from agent process");
  }
  return {
    input: Writable.toWeb(stdin),
    output: toUint8ReadableStream(Readable.toWeb(stdout)),
    dispose: () => {
      agentProcess.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// TCP transport — connect to an alchemy-managed container over the network
// ---------------------------------------------------------------------------

export function openTcpTransport(host: string, port: number): Promise<AcpTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      // For a duplex socket, split read/write manually rather than
      // using Writable.toWeb + Readable.toWeb on the same object.
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

      resolve({
        input,
        output,
        dispose: () => {
          socket.destroy();
        },
      });
    });
    socket.on("error", reject);
  });
}
