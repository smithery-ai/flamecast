import path from "node:path";
// Suppress ECONNREFUSED during shutdown — pglite-server cleanup races with Miniflare's
// open postgres connections. Alchemy's onExit handler calls scope.cleanup() which kills
// pglite-server, but Miniflare's postgres.js client throws before cleanup completes.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "ECONNREFUSED") return;
  throw err;
});
import alchemy from "alchemy";
import { Worker, Vite } from "alchemy/cloudflare";
import { FlamecastDatabase } from "./packages/flamecast/src/alchemy/database.ts";
import { FlamecastRuntime } from "./packages/flamecast/src/alchemy/runtime.ts";

const app = await alchemy("flame-ctl", {
  password: process.env.ALCHEMY_PASSWORD ?? "local-dev-password",
});

const db = await FlamecastDatabase("flamecast-db", {});

const runtime = await FlamecastRuntime("flamecast-runtime", {
  bridgeEntry: "./packages/runtime-bridge/dist/index.js",
  dockerfile: "./packages/runtime-bridge/Dockerfile",
});

export const server = await Worker("flamecast-api", {
  name: `flamecast-api-${app.stage}`,
  entrypoint: "./packages/flamecast/src/worker.ts",
  format: "esm",
  compatibility: "node",
  bindings: {
    DATABASE: db.binding,
    RUNTIME_URL: runtime.url,
    WORKSPACE_ROOT: process.cwd(),
  },
  url: true,
  dev: {
    port: 3001,
  },
});

export const client = await Vite("flamecast-client", {
  name: `flamecast-client-${app.stage}`,
  cwd: "./packages/flamecast",
  bindings: {
    VITE_FLAMECAST_API_URL: `${server.url}api`,
  },
  dev: {
    command: `PATH=${path.dirname(process.execPath)}:$PATH npx vite dev --port 3000`,
  },
});

console.log(`API: ${server.url}`);

await app.finalize();

// Alchemy doesn't call scope.cleanup() on SIGINT in dev mode — do it manually
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.cleanup();
    process.exit(0);
  });
}
