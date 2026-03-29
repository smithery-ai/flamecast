// `runtime-e2b` intentionally deep-imports `e2b/dist/index.mjs` instead of the
// package root. On Vercel, the default resolution path can land on E2B's
// CommonJS bundle, which pulls in ESM-only `chalk` via `require()` and fails at
// startup. Importing the published `.mjs` entry forces the ESM build and avoids
// that runtime path.
//
// TypeScript does not get a typed module declaration for this deep subpath from
// E2B's package metadata, so we provide one locally and map it back to the
// public `e2b` types. This file is only a compile-time shim; it does not affect
// runtime behavior. If E2B eventually ships typed exports for
// `e2b/dist/index.mjs`, this shim can be removed.
declare module "e2b/dist/index.mjs" {
  export { default } from "e2b";
  export * from "e2b";
}
