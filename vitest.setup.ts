/// <reference types="vitest" />

import type { TestProject } from "vitest/node";

export async function setup({ provide }: TestProject) {
  const { serve } = await import("@hono/node-server");
  const { Flamecast } = await import("./src/flamecast/index.ts");

  const flamecast = await Flamecast.create({
    stateManager: { type: "memory" },
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: flamecast.fetch, port: 0 }, (info) => {
      provide("apiBaseUrl", `http://localhost:${info.port}`);
      resolve(s);
    });
  });

  return async () => {
    server.close();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    apiBaseUrl: string;
  }
}
