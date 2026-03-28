/**
 * Stable download URL for the runtime-host binary (GitHub release).
 */
export declare const SESSION_HOST_DEFAULT_URL: string;

/**
 * Resolve a download URL for the runtime-host binary.
 *
 * Resolution order:
 *  1. `SESSION_HOST_URL` env var
 *  2. Stable default URL
 */
export declare function resolveSessionHostUrl(): string;

/**
 * Try to find a Linux runtime-host binary on the local filesystem.
 * Used by Docker and E2B runtimes.
 *
 * @param arch - Target architecture ("amd64" | "arm64"). If omitted, uses default binary.
 * @returns Absolute path to the binary, or null if not found.
 */
export declare function resolveSessionHostBinary(arch?: string): string | null;

/**
 * Try to find the native (host OS/arch) runtime-host binary.
 * Used by NodeRuntime for local development.
 *
 * @returns Absolute path to the native binary, or null if not found.
 */
export declare function resolveNativeBinary(): string | null;
