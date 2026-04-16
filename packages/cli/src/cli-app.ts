import { runUp } from "./commands/up.js";
import { runDown } from "./commands/down.js";
import { runStatus } from "./commands/status.js";
import type { DownFlags, UpFlags } from "./types.js";

type Command =
  | { kind: "help" }
  | { kind: "up"; flags: UpFlags }
  | { kind: "down"; flags: DownFlags }
  | { kind: "status" };

function printHelp(): void {
  console.log(`Usage:
  flamecast up [--name <name>] [--port <port>]
  flamecast down [--deregister]
  flamecast status

Commands:
  up                   Start Flamecast server
  down                 Stop the running daemon
  status               Show whether Flamecast is running

Options:
  --name <name>        Expose as name.flamecast.dev (requires cloudflared)
  --port <port>        Port to listen on (default: 3000)
  --deregister         Remove saved machine registration on shutdown

Environment:
  FLAMECAST_PORT or PORT               Default serve port (3000)
  FLAMECAST_MACHINES_API_URL           Override Machines API URL
  FLAMECAST_MACHINES_URL               Override Machines API URL
  FLAMECAST_BRIDGE_URL                 Backward-compatible Machines API override
`);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }
  return parsed;
}

function parseUpFlags(args: string[]): UpFlags {
  const flags: UpFlags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}"`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for "${arg}"`);
    }

    if (arg === "--name") {
      flags.name = value;
    } else if (arg === "--port") {
      flags.port = parsePort(value, 3000);
    } else {
      throw new Error(`Unknown flag "${arg}"`);
    }

    index += 1;
  }

  return flags;
}

function parseDownFlags(args: string[]): DownFlags {
  const flags: DownFlags = {};

  for (const arg of args) {
    if (arg === "--deregister") {
      flags.deregister = true;
      continue;
    }

    throw new Error(`Unknown flag "${arg}"`);
  }

  return flags;
}

export function parseCliArgs(argv: string[]): Command {
  if (argv.length === 0) {
    return { kind: "up", flags: {} };
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    return { kind: "help" };
  }

  const [first, second, ...rest] = argv;

  if (first === "up") {
    return {
      kind: "up",
      flags: parseUpFlags([second, ...rest].filter((v): v is string => v !== undefined)),
    };
  }

  if (first === "down") {
    return {
      kind: "down",
      flags: parseDownFlags([second, ...rest].filter((v): v is string => v !== undefined)),
    };
  }

  if (first === "status") {
    return { kind: "status" };
  }

  throw new Error(`Unknown command "${first}"`);
}

export async function runCli(argv: string[]): Promise<number> {
  const command = parseCliArgs(argv);

  if (command.kind === "help") {
    printHelp();
    return 0;
  }

  if (command.kind === "up") {
    return runUp(command.flags);
  }

  if (command.kind === "down") {
    return runDown(command.flags);
  }

  return runStatus();
}
