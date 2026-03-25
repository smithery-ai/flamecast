/**
 * Re-exports from @flamecast/protocol with SDK-specific extensions.
 *
 * The protocol package defines the zero-dep Runtime interface.
 * The SDK re-exports everything and adds configSchema (zod) for
 * runtimes that want schema-validated config.
 */
export type {
  RuntimeNames,
  RuntimeConfigFor,
  SessionContext,
  SessionEndReason,
} from "@flamecast/protocol/runtime";

// Re-export Runtime from protocol — the configSchema field was unused
// and removed to keep the protocol package zero-dep. If needed later,
// extend it here with: Runtime & { configSchema?: ZodType<TConfig> }
export type { Runtime } from "@flamecast/protocol/runtime";
