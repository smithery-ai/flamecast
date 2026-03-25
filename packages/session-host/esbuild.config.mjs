import { build } from "esbuild";

/** Bundle session-host into a single self-contained JS file for SEA compilation. */
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/session-host.bundle.cjs",
  // Inline every dependency — the resulting file must be fully self-contained.
  external: [],
  // Minify to reduce binary size once embedded in the SEA blob.
  minify: true,
  // Keep function/class names for useful stack traces.
  keepNames: true,
  // Produce a source map for debugging (not embedded in the SEA).
  sourcemap: true,
  // No shebang — SEA's useCodeCache requires valid JS without shebangs.
  // The bundle runs via `node dist/session-host.bundle.cjs` or as an embedded SEA.
});

console.log("✓ session-host bundled → dist/session-host.bundle.cjs");
