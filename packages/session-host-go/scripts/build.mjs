#!/usr/bin/env node
/**
 * postinstall script — builds the Go runtime-host binary for Linux.
 *
 * Builds for BOTH amd64 and arm64 so that runtimes targeting different
 * architectures (e.g. Docker on Apple Silicon = arm64, E2B = amd64) can
 * each resolve the correct binary.
 *
 * Output:
 *   dist/runtime-host        — host arch (default for DockerRuntime)
 *   dist/runtime-host-amd64  — always amd64
 *   dist/runtime-host-arm64  — always arm64
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch } from "node:os";
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
const archs = ["amd64", "arm64"];

for (const goArch of archs) {
  const output = join(distDir, `runtime-host-${goArch}`);
  if (existsSync(output) && process.env.SKIP_BUILD) {
    console.log(`[session-host-go] runtime-host-${goArch} already exists, skipping`);
    continue;
  }

  console.log(`[session-host-go] building static binary (linux/${goArch})...`);
  try {
    execFileSync("go", ["build", "-o", output, "-ldflags=-s -w", "."], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goArch },
    });
    console.log(`[session-host-go] ✓ built dist/runtime-host-${goArch}`);
  } catch (err) {
    console.error(`[session-host-go] build failed (${goArch}):`, err.message);
    process.exit(1);
  }
}

// Copy host-arch binary as the default
const defaultBinary = join(distDir, "runtime-host");
copyFileSync(join(distDir, `runtime-host-${hostArch}`), defaultBinary);
console.log(`[session-host-go] ✓ dist/runtime-host -> runtime-host-${hostArch} (default)`);
