import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { SessionManager } from "./sessions/session-manager.js";
import { sessionRoutes } from "./routes/sessions.js";
import { StreamManager } from "./stream-manager.js";
import { attachWebSocketServer, type WebSocketServerOptions } from "./ws.js";
import { createMcpHandler } from "./mcp.js";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, "utf-8"));

function createApp(sessions: SessionManager) {
  const app = new OpenAPIHono();
  app.onError((err, c) => {
    return c.json({ error: err.message }, 500);
  });

  // MCP streamable HTTP endpoint
  const handleMcp = createMcpHandler(sessions);
  app.all("/mcp", (c) => handleMcp(c));

  const routes = app
    .get("/", (c) => c.json({ name: "flamecast", status: "ok" }))
    .route("/api", sessionRoutes(sessions));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Flamecast", version: pkg.version },
  });
  app.get("/api/ui", swaggerUI({ url: "/openapi.json" }));

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
export type { WebSocketServerOptions } from "./ws.js";

export class Flamecast {
  readonly app: AppType;
  readonly sessions: SessionManager;
  readonly streams: StreamManager;

  constructor() {
    this.sessions = new SessionManager();
    this.streams = new StreamManager();
    this.app = createApp(this.sessions);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachWebSockets(httpServer: any, options?: WebSocketServerOptions): void {
    attachWebSocketServer(httpServer, this.streams, this.sessions, options);
  }
}
