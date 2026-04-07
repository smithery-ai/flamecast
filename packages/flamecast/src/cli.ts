#!/usr/bin/env node

import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { runCli } from "./cli-app.js";

// Load env files in precedence order (later files don't override earlier ones).
const envFiles = [".env.local", ".env"];
const loaded = envFiles.filter((file) => {
  if (!existsSync(file)) return false;
  dotenv.config({ path: file });
  return true;
});

if (loaded.length === 0) {
  console.warn("No .env file found in local directory, using environment variables");
}

try {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
