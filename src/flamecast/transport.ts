import { ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";

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
