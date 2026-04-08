/**
 * Shared runtime-host binary resolution for all runtimes.
 *
 * This module lives in @flamecast/session-host-go so that the package
 * that owns the binary also owns the logic to find it.
 *
 * Plain .mjs (no build step) — both runtime-docker and runtime-e2b
 * import from "@flamecast/session-host-go/resolve".
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stable download URL for the runtime-host binary. Uses a pinned
 * `session-host-latest` release tag that CI overwrites on each build,
 * so this URL never changes.
 */
export const SESSION_HOST_DEFAULT_URL =
  "https://github.com/smithery-ai/flamecast/releases/download/session-host-latest/session-host-linux-amd64";

/**
 * Resolve a download URL for the runtime-host binary.
 *
 * Resolution order:
 *  1. `SESSION_HOST_URL` env var (explicit override, works for any runtime)
 *  2. Stable default URL (GitHub release tag `session-host-latest`)
 *
 * @returns {string} URL to download the binary from
 */
export function resolveSessionHostUrl() {
  const envUrl = typeof process !== "undefined" ? process.env?.SESSION_HOST_URL : undefined;
  return envUrl ?? SESSION_HOST_DEFAULT_URL;
}

/**
 * Try to find a Linux runtime-host binary on the local filesystem.
 * Used by Docker and E2B runtimes that need a Linux binary to copy
 * into containers/sandboxes.
 *
 * Resolution order:
 *  1. `SESSION_HOST_BINARY` env var (explicit override)
 *  2. `@flamecast/session-host-go/dist/session-host-{arch}` via package resolution
 *
 * @param {string} [arch] - Target architecture ("amd64" | "arm64"). If omitted, uses the
 *   default `dist/session-host` binary (host architecture).
 * @returns {string | null} Absolute path to the binary, or null if not found.
 *   Throws if SESSION_HOST_BINARY is set but the file doesn't exist.
 */
export function resolveSessionHostBinary(arch) {
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    return p;
  }

  // Resolve relative to this file (which lives inside @flamecast/session-host-go)
  const pkgDir = dirname(fileURLToPath(import.meta.url));
  const binaryName = arch ? `session-host-${arch}` : "session-host";
  const binaryPath = join(pkgDir, "dist", binaryName);
  if (existsSync(binaryPath)) return binaryPath;

  return null;
}

/**
 * Try to find the native (host OS/arch) runtime-host binary.
 * Used by NodeRuntime for local development — this binary runs on
 * the developer's machine, not inside a container.
 *
 * Resolution order:
 *  1. `SESSION_HOST_BINARY` env var (explicit override)
 *  2. `@flamecast/session-host-go/dist/session-host-native`
 *
 * @returns {string | null} Absolute path to the native binary, or null if not found.
 */
export function resolveNativeBinary() {
  if (process.env.SESSION_HOST_BINARY) {
    const p = process.env.SESSION_HOST_BINARY;
    if (!existsSync(p)) {
      throw new Error(`SESSION_HOST_BINARY points to "${p}" which does not exist`);
    }
    return p;
  }

  const pkgDir = dirname(fileURLToPath(import.meta.url));
  const binaryPath = join(pkgDir, "dist", "session-host-native");
  if (existsSync(binaryPath)) return binaryPath;

  return null;
}
