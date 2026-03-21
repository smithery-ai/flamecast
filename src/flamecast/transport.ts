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

export function startAgentProcess(spec: { command: string; args?: string[] }): ChildProcess {
  const args = spec.args ?? [];
  return spawn(spec.command, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
}

export function openLocalTransport(spec: {
  command: string;
  args?: string[];
}): AcpTransport & { kill: () => void } {
  const agentProcess = startAgentProcess(spec);
  const { input, output } = getAgentTransport(agentProcess);
  return { input, output, kill: () => agentProcess.kill() };
}

export function getAgentTransport(agentProcess: ChildProcess) {
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
// TCP transport
// ---------------------------------------------------------------------------

export function openTcpTransport(host: string, port: number): Promise<AcpTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      console.log(`[tcp] connected to ${host}:${port}`);
      socket.setNoDelay(true);
      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          console.log(`[tcp] write ${chunk.length} bytes`);
          return new Promise<void>((res, rej) => {
            socket.write(chunk, (err) => (err ? rej(err) : res()));
          });
        },
        close() { socket.end(); },
      });
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          socket.on("data", (chunk: Buffer) => {
            console.log(`[tcp] recv ${chunk.length} bytes`);
            controller.enqueue(new Uint8Array(chunk));
          });
          socket.on("end", () => controller.close());
          socket.on("error", (err) => controller.error(err));
        },
        cancel() { socket.destroy(); },
      });
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
