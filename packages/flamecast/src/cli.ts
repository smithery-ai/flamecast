#!/usr/bin/env node

import { resolve } from "node:path";
import { Flamecast } from "./index.js";

function parsePort(value: string | undefined): number {
  if (!value) {
    return 3001;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port "${value}"`);
  }

  return parsed;
}

function parseCwd(args: string[]): string | undefined {
  const idx = args.indexOf("--cwd");
  if (idx !== -1 && idx + 1 < args.length) {
    return resolve(args[idx + 1]!);
  }
  if (process.env.FLAMECAST_CWD) {
    return resolve(process.env.FLAMECAST_CWD);
  }
  return undefined;
}

const port = parsePort(process.env.FLAMECAST_PORT ?? process.env.PORT);
const cwd = parseCwd(process.argv.slice(2));
const flamecast = new Flamecast({ cwd });
const server = await flamecast.listen(port);

console.log(`API: http://localhost:${port}/api`);
if (cwd) {
  console.log(`CWD: ${cwd}`);
}

async function shutdown() {
  console.log("\nShutting down...");
  await flamecast.shutdown();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
