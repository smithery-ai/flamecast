import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { SessionManager } from "./sessions/session-manager.js";
import { sessionRoutes } from "./routes/sessions.js";
import { portRoutes } from "./routes/port.js";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, "utf-8"));

export interface FlamecastOptions {
  allowedPorts?: number[];
}

function createApp(sessions: SessionManager, options?: FlamecastOptions) {
  const app = new OpenAPIHono();

  app.onError((err, c) => {
    return c.json({ error: err.message }, 500);
  });

  const routes = app
    .get("/", (c) => c.json({ name: "flamecast", status: "ok" }))
    .route("/api", sessionRoutes(sessions))
    .route("/port", portRoutes(options?.allowedPorts));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Flamecast", version: pkg.version },
  });
  app.get("/api/ui", swaggerUI({ url: "/openapi.json" }));

  return routes;
}

export type AppType = ReturnType<typeof createApp>;

export class Flamecast {
  readonly app: AppType;
  readonly sessions: SessionManager;

  constructor(options?: FlamecastOptions) {
    this.sessions = new SessionManager();
    this.app = createApp(this.sessions, options);
  }
}
