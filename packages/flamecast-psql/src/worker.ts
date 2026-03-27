/**
 * Lightweight entry point for bundled environments (e.g. Cloudflare Workers)
 * that cannot use `import.meta.url` or the Node.js filesystem at module load
 * time. Exports only the storage layer and drizzle helpers — no migrations,
 * no PGLite, no default templates.
 *
 * Migrations must be run separately (e.g. via CI or a local script).
 */
export { createStorageFromDb } from "./storage.js";
export type { PsqlAppDb } from "./types.js";
export * as schema from "./schema.js";
