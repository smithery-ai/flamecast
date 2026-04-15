import { Hono } from "hono";

export class Flamecast {
  readonly app: Hono;

  constructor() {
    this.app = new Hono();
    this.app.get("/", (c) => c.json({ name: "flamecast", status: "ok" }));
  }
}
