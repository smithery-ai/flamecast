import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { platform, arch } from "node:os";
import { createRestateEndpoint } from "./endpoint.js";

// Same resolution logic as @restatedev/restate-server's own index.ts
function getExePath(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@restatedev/restate-server/package.json");
  return createRequire(pkg).resolve(
    `@restatedev/restate-server-${platform()}-${arch()}/bin/restate-server`,
  );
}

/**
 * Start the Flamecast Restate endpoint, a local restate-server, and register
 * the deployment. Returns a stop function for graceful shutdown.
 */
export async function autoStartRestate(opts?: {
  ingressPort?: number;
  adminPort?: number;
  endpointPort?: number;
}): Promise<{ ingressUrl: string; adminUrl: string; stop: () => void }> {
  const ingressPort = opts?.ingressPort ?? 18080;
  const adminPort = opts?.adminPort ?? 19070;
  const endpointPort = opts?.endpointPort ?? 9080;
  const ingressUrl = `http://localhost:${ingressPort}`;
  const adminUrl = `http://localhost:${adminPort}`;
  const endpointUrl = `http://localhost:${endpointPort}`;

  // 1. Start the Flamecast VO endpoint
  await createRestateEndpoint().listen(endpointPort);
  console.log(`[restate] Endpoint listening on :${endpointPort}`);

  // 2. Start restate-server directly (no npx indirection)
  const server: ChildProcess = spawn(getExePath(), [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RESTATE_INGRESS__BIND_PORT: String(ingressPort),
      RESTATE_ADMIN__BIND_PORT: String(adminPort),
    },
  });

  // 3. Wait for healthy
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      if ((await fetch(`${adminUrl}/health`)).ok) break;
    } catch {}
  }
  console.log(`[restate] Server ready (ingress :${ingressPort}, admin :${adminPort})`);

  // 4. Register deployment (POST /deployments, idempotent with force: true)
  const resp = await fetch(`${adminUrl}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri: endpointUrl }),
  });
  if (!resp.ok) {
    console.warn(`[restate] Registration failed (${resp.status}): ${await resp.text()}`);
  } else {
    const result = await resp.json() as { services?: Array<{ name: string }> };
    const names = result.services?.map((s) => s.name) ?? [];
    console.log(`[restate] Registered services: ${names.join(", ")}`);
  }

  return {
    ingressUrl,
    adminUrl,
    stop: () => server.kill("SIGTERM"),
  };
}
