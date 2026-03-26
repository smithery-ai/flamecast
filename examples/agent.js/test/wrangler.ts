import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const exampleDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = require.resolve("wrangler/bin/wrangler.js");

type Bindings = Record<string, string>;

async function getFreePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a local TCP port");
  }

  return address.port;
}

async function waitForHealth(url: string, getOutput: () => string, isAlive: () => boolean) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error(`Wrangler exited before becoming healthy\n\n${getOutput()}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}\n\n${getOutput()}`);
}

export async function startExampleWorker({
  bindings = { AGENT_MODE: "scripted" },
  port,
}: {
  bindings?: Bindings;
  port?: number;
} = {}) {
  const resolvedPort = port ?? (await getFreePort());
  const args = [
    wranglerBin,
    "dev",
    "--config",
    "wrangler.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(resolvedPort),
    "--show-interactive-dev-session=false",
  ];

  for (const [key, value] of Object.entries(bindings)) {
    args.push("--var", `${key}:${value}`);
  }

  const child = spawn(process.execPath, args, {
    cwd: exampleDir,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  const isAlive = () => child.exitCode === null && !child.killed;
  const baseUrl = `http://127.0.0.1:${resolvedPort}`;
  await waitForHealth(`${baseUrl}/health`, () => output, isAlive);

  return {
    baseUrl,
    dispose: async () => {
      if (!isAlive()) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 3_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}
