#!/usr/bin/env node
/**
 * postinstall script — builds the Go session-host binary for Linux.
 *
 * Always targets linux (since the binary runs inside Docker containers),
 * and builds for the host's CPU architecture by default.
 * Skips gracefully if Go is not installed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const output = join(root, "dist", "session-host");

// Skip if already built
if (existsSync(output)) {
  console.log("[session-host-go] binary already exists, skipping build");
  process.exit(0);
}

// Check Go is available
try {
  execFileSync("go", ["version"], { stdio: "pipe" });
} catch {
  console.warn(
    "[session-host-go] Go is not installed — skipping binary build.\n" +
      "  Install Go (https://go.dev/dl/) and run: pnpm --filter @flamecast/session-host-go run postinstall",
  );
  process.exit(0);
}

// Map Node.js arch names to Go arch names
const goArch = { x64: "amd64", arm64: "arm64" }[arch()] ?? "amd64";

mkdirSync(join(root, "dist"), { recursive: true });

console.log(`[session-host-go] building static binary (linux/${goArch})...`);
try {
  execFileSync("go", ["build", "-o", output, "-ldflags=-s -w", "."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goArch },
  });
  console.log("[session-host-go] ✓ built dist/session-host");
} catch (err) {
  console.error("[session-host-go] build failed:", err.message);
  process.exit(1);
}
