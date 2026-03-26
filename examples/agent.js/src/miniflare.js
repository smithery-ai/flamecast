import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { startLocalExecutor } from "./local-executor.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, "worker.js");
const localEnvPath = resolve(here, "../.env");
const DEFAULT_LOCAL_GATEWAY = {
  CF_ACCOUNT_ID: "c4cf21d8a5e8878bc3c92708b1f80193",
  CF_AI_GATEWAY: "smithery-agent",
  CF_AI_MODEL: "openai/gpt-5.4",
};

export function loadExampleEnv(target = process.env) {
  if (!existsSync(localEnvPath)) {
    return;
  }

  const source = readFileSync(localEnvPath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    if (!key || key in target) {
      continue;
    }

    let value = normalized.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}

export function createBindings(env = process.env, overrides = {}) {
  const gatewayToken = env.CF_AI_GATEWAY_TOKEN ?? "";
  const mode = env.AGENT_MODE ?? (gatewayToken ? "gateway" : "scripted");

  return {
    AGENT_MODE: mode,
    COMPACT_AT_CHARS: env.COMPACT_AT_CHARS ?? "12000",
    KEEP_RECENT_TURNS: env.KEEP_RECENT_TURNS ?? "6",
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID ?? DEFAULT_LOCAL_GATEWAY.CF_ACCOUNT_ID,
    CF_AI_GATEWAY: env.CF_AI_GATEWAY ?? DEFAULT_LOCAL_GATEWAY.CF_AI_GATEWAY,
    CF_AI_GATEWAY_TOKEN: gatewayToken,
    CF_AI_MODEL: env.CF_AI_MODEL ?? DEFAULT_LOCAL_GATEWAY.CF_AI_MODEL,
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    ...overrides,
  };
}

export async function startExampleMiniflare({ bindings = {}, port } = {}) {
  loadExampleEnv();
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
    external: ["cloudflare:*", "node:*", "path", "os"],
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
    compatibilityFlags: ["nodejs_compat"],
    durableObjectsPersist: false,
    durableObjects: {
      AcpSessionAgent: {
        className: "AcpSessionAgent",
        useSQLite: true,
      },
    },
    bindings: createBindings(process.env, {
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
  loadExampleEnv();
  const bindings = createBindings();
  const local = await startExampleMiniflare();

  console.log(`Agent.js worker listening at ${local.baseUrl}`);
  console.log(`ACP WebSocket base: ${local.websocketUrl}/:sessionId`);
  console.log(
    `Mode: ${bindings.AGENT_MODE}${bindings.CF_AI_MODEL ? ` (${bindings.CF_AI_MODEL})` : ""}`,
  );
  if (bindings.AGENT_MODE === "gateway" && !bindings.OPENAI_API_KEY) {
    console.log(
      "Gateway note: if prompts still fall back to scripted responses, configure a stored provider key on the gateway or set OPENAI_API_KEY locally.",
    );
  }

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
