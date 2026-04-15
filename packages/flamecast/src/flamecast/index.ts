import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { SessionManager } from "./sessions/session-manager.js";
import { sessionRoutes } from "./routes/sessions.js";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, "utf-8"));

export class Flamecast {
  readonly app: OpenAPIHono;
  readonly sessions: SessionManager;

  constructor() {
    this.sessions = new SessionManager();
    this.app = new OpenAPIHono();

    this.app.get("/", (c) => c.json({ name: "flamecast", status: "ok" }));
    this.app.route("/api", sessionRoutes(this.sessions));

    this.app.doc("/openapi.json", {
      openapi: "3.1.0",
      info: { title: "Flamecast", version: pkg.version },
    });
    this.app.get("/api/ui", swaggerUI({ url: "/openapi.json" }));
  }
}
