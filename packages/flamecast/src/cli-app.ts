/**
 * Flamecast CLI — simplified after 5a cleanup.
 *
 * No Postgres dependency. Agent templates are in-memory config.
 * Session lifecycle is managed by Restate VOs.
 */

import { serve } from "@hono/node-server";
import { Flamecast, NodeRuntime } from "./index.js";

type Command =
  | { kind: "help" }
  | { kind: "serve"; flags: CliFlags };

type CliFlags = {
  port?: string;
  restateUrl?: string;
};

function printHelp(): void {
  console.log(`Usage:
  flamecast serve [--port <port>] [--restate-url <url>]

Environment:
  RESTATE_INGRESS_URL  Restate ingress URL (default: http://localhost:18080)
  FLAMECAST_PORT       Default serve port (3001)
  PORT                 Alternative port variable
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

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}"`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for "${arg}"`);

    if (arg === "--port") flags.port = value;
    else if (arg === "--restate-url") flags.restateUrl = value;
    else throw new Error(`Unknown flag "${arg}"`);
  }
  return flags;
}

export function parseCliArgs(argv: string[]): Command {
  if (argv.length === 0) return { kind: "serve", flags: {} };
  if (argv.includes("-h") || argv.includes("--help")) return { kind: "help" };

  const [first, ...rest] = argv;
  if (first === "serve") return { kind: "serve", flags: parseFlags(rest) };
  throw new Error(`Unknown command "${first}"`);
}

async function runServeCommand(flags: CliFlags): Promise<number> {
  const port = parsePort(
    flags.port ?? process.env.FLAMECAST_PORT ?? process.env.PORT,
    3001,
  );
  const restateUrl =
    flags.restateUrl ?? process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";

  const flamecast = new Flamecast({
    runtimes: { default: new NodeRuntime() },
    restateUrl,
  });

  serve({ fetch: flamecast.app.fetch, port }, () => {
    console.log(`Flamecast running on http://localhost:${port}`);
    console.log(`  Restate ingress: ${restateUrl}`);
  });

  return await new Promise<number>((resolve) => {
    let shuttingDown = false;
    async function shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("\nShutting down...");
      await flamecast.close();
      resolve(0);
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const cmd = parseCliArgs(argv);
    switch (cmd.kind) {
      case "help":
        printHelp();
        return 0;
      case "serve":
        return await runServeCommand(cmd.flags);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
