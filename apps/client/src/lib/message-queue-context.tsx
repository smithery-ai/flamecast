/**
 * Re-export the server-side QueuedMessage type for use across the client app.
 * The actual data now lives on the server in pglite, accessed via React Query
 * hooks from @flamecast/ui.
 */
export type { QueuedMessage } from "@flamecast/protocol/storage";
