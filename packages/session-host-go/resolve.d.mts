/**
 * Stable download URL for the session-host binary (GitHub release).
 */
export declare const SESSION_HOST_DEFAULT_URL: string;

/**
 * Resolve a download URL for the session-host binary.
 *
 * Resolution order:
 *  1. `SESSION_HOST_URL` env var
 *  2. Stable default URL
 */
export declare function resolveSessionHostUrl(): string;

/**
 * Try to find the session-host binary on the local filesystem.
 *
 * @param arch - Target architecture ("amd64" | "arm64"). If omitted, uses default binary.
 * @returns Absolute path to the binary, or null if not found.
 */
export declare function resolveSessionHostBinary(arch?: string): string | null;
