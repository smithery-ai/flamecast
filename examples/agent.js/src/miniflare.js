import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { startLocalExecutor } from "./local-executor.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, "worker.js");

function createBindings(overrides = {}) {
  return {
    AGENT_MODE: process.env.AGENT_MODE ?? "scripted",
    COMPACT_AT_CHARS: process.env.COMPACT_AT_CHARS ?? "12000",
    KEEP_RECENT_TURNS: process.env.KEEP_RECENT_TURNS ?? "6",
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID ?? "",
    CF_AI_GATEWAY: process.env.CF_AI_GATEWAY ?? "",
    CF_AI_GATEWAY_TOKEN: process.env.CF_AI_GATEWAY_TOKEN ?? "",
    CF_AI_MODEL: process.env.CF_AI_MODEL ?? "",
    ...overrides,
  };
}

export async function startExampleMiniflare({ bindings = {}, port } = {}) {
  const executor = await startLocalExecutor();
  const { outputFiles } = await build({
    entryPoints: [workerPath],
    write: false,
    bundle: true,
    format: "esm",
    minify: true,
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
  });
  const script = outputFiles[0]?.text;

  if (!script) {
    throw new Error("Failed to bundle worker for Miniflare");
  }

  const mf = new Miniflare({
    host: "127.0.0.1",
    port: port ?? Number(process.env.PORT ?? 8787),
    modules: true,
    script,
    compatibilityDate: "2026-03-25",
    bindings: createBindings({
      LOCAL_EXECUTOR_URL: executor.url,
      ...bindings,
    }),
  });

  const ready = await mf.ready;
  const baseUrl = ready.toString();
  const websocketUrl = new URL("/acp", ready);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";

  return {
    mf,
    baseUrl,
    websocketUrl: websocketUrl.toString(),
    dispose: async () => {
      await mf.dispose();
      await executor.dispose();
    },
  };
}

async function main() {
  const local = await startExampleMiniflare();

  console.log(`Agent.js worker listening at ${local.baseUrl}`);
  console.log(`ACP WebSocket endpoint: ${local.websocketUrl}`);
  console.log(
    `Mode: ${process.env.AGENT_MODE ?? "scripted"}${process.env.CF_AI_MODEL ? ` (${process.env.CF_AI_MODEL})` : ""}`,
  );

  const stop = async () => {
    await local.dispose();
    process.exit(0);
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
