import { runUp } from "./commands/up.js";
import { runDown } from "./commands/down.js";
import { runStatus } from "./commands/status.js";
import { runDbStatus, runDbMigrate, runDbStudio, type DbFlags } from "./commands/db.js";
import type { UpFlags } from "./types.js";

type Command =
  | { kind: "help" }
  | { kind: "up"; flags: UpFlags }
  | { kind: "down" }
  | { kind: "status" }
  | { kind: "db-status"; flags: DbFlags }
  | { kind: "db-migrate"; flags: DbFlags }
  | { kind: "db-studio"; flags: DbFlags };

function printHelp(): void {
  console.log(`Usage:
  flamecast up [--name <name>] [--url <postgres-url>] [--data-dir <path>] [--port <port>]
  flamecast down
  flamecast status
  flamecast db status [--url <postgres-url>] [--data-dir <path>] [--json]
  flamecast db migrate [--url <postgres-url>] [--data-dir <path>]
  flamecast db studio [--url <postgres-url>] [--data-dir <path>] [--host <host>] [--port <port>]

Commands:
  up                   Start Flamecast as a background daemon
  down                 Stop the running daemon
  status               Show whether Flamecast is running

Options:
  --name <name>        Expose as name.flamecast.app (requires cloudflared)

Environment:
  DATABASE_URL or POSTGRES_URL         Postgres connection string
  FLAMECAST_PGLITE_DIR                 Override the default PGLite data directory
  FLAMECAST_PORT or PORT               Default serve port (3001)
  FLAMECAST_BRIDGE_URL                 Override bridge URL
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

function parseDbFlags(args: string[]): DbFlags {
  const flags: DbFlags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}"`);
    }

    if (arg === "--json") {
      flags.json = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for "${arg}"`);
    }

    if (arg === "--url") {
      flags.url = value;
    } else if (arg === "--data-dir") {
      flags.dataDir = value;
    } else if (arg === "--host") {
      flags.host = value;
    } else if (arg === "--port") {
      flags.port = value;
    } else {
      throw new Error(`Unknown flag "${arg}"`);
    }

    index += 1;
  }

  return flags;
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
    } else if (arg === "--url") {
      flags.url = value;
    } else if (arg === "--data-dir") {
      flags.dataDir = value;
    } else if (arg === "--port") {
      flags.port = parsePort(value, 3001);
    } else {
      throw new Error(`Unknown flag "${arg}"`);
    }

    index += 1;
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
    return { kind: "down" };
  }

  if (first === "status") {
    return { kind: "status" };
  }

  if (first === "db") {
    if (!second) {
      throw new Error('Missing db subcommand. Expected "status", "migrate", or "studio".');
    }

    if (second === "status") {
      return { kind: "db-status", flags: parseDbFlags(rest) };
    }

    if (second === "migrate") {
      return { kind: "db-migrate", flags: parseDbFlags(rest) };
    }

    if (second === "studio") {
      return { kind: "db-studio", flags: parseDbFlags(rest) };
    }

    throw new Error(`Unknown db subcommand "${second}"`);
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
    return runDown();
  }

  if (command.kind === "status") {
    return runStatus();
  }

  if (command.kind === "db-status") {
    return runDbStatus(command.flags);
  }

  if (command.kind === "db-migrate") {
    return runDbMigrate(command.flags);
  }

  return runDbStudio(command.flags);
}
