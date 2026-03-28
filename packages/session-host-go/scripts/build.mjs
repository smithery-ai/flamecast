#!/usr/bin/env node
/**
 * postinstall script — builds the Go runtime-host binary.
 *
 * Builds:
 *   1. A native binary for the host OS/arch (for local dev via NodeRuntime)
 *   2. Linux binaries for amd64 and arm64 (for Docker/E2B runtimes)
 *
 * Output:
 *   dist/session-host-native — host OS + arch (used by NodeRuntime)
 *   dist/session-host        — linux, host arch (default for DockerRuntime)
 *   dist/session-host-amd64  — linux, always amd64
 *   dist/session-host-arm64  — linux, always arm64
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distDir = join(root, "dist");

// Check Go is available
try {
  execFileSync("go", ["version"], { stdio: "pipe" });
} catch {
  console.error(
    "[session-host-go] ERROR: Go is not installed.\n" +
      "  Install Go (https://go.dev/dl/) and run: pnpm --filter @flamecast/session-host-go run postinstall",
  );
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });

const hostArch = { x64: "amd64", arm64: "arm64" }[arch()] ?? "amd64";
const hostOs = platform();

// ---- Native binary (for local dev) ----

const nativeOutput = join(distDir, "session-host-native");
if (existsSync(nativeOutput) && process.env.SKIP_BUILD) {
  console.log(`[session-host-go] session-host-native already exists, skipping`);
} else {
  console.log(`[session-host-go] building native binary (${hostOs}/${hostArch})...`);
  try {
    execFileSync("go", ["build", "-o", nativeOutput, "-ldflags=-s -w", "."], {
      cwd: root,
      stdio: "inherit",
    });
    console.log(`[session-host-go] ✓ built dist/session-host-native`);
  } catch (err) {
    console.error(`[session-host-go] native build failed:`, err.message);
    process.exit(1);
  }
}

// ---- Linux cross-compile binaries (for Docker/E2B) ----

const linuxArchs = ["amd64", "arm64"];

for (const goArch of linuxArchs) {
  const output = join(distDir, `session-host-${goArch}`);
  if (existsSync(output) && process.env.SKIP_BUILD) {
    console.log(`[session-host-go] session-host-${goArch} already exists, skipping`);
    continue;
  }

  console.log(`[session-host-go] building static binary (linux/${goArch})...`);
  try {
    execFileSync("go", ["build", "-o", output, "-ldflags=-s -w", "."], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goArch },
    });
    console.log(`[session-host-go] ✓ built dist/session-host-${goArch}`);
  } catch (err) {
    console.error(`[session-host-go] build failed (${goArch}):`, err.message);
    process.exit(1);
  }
}

// Copy host-arch Linux binary as the default (for DockerRuntime)
const defaultBinary = join(distDir, "session-host");
copyFileSync(join(distDir, `session-host-${hostArch}`), defaultBinary);
console.log(`[session-host-go] ✓ dist/session-host -> session-host-${hostArch} (default)`);
