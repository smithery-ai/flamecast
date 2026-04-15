import { hc } from "hono/client";
import type { AppType } from "./index.js";

type Client = ReturnType<typeof hc<AppType>>;

export class FlamecastClient {
  readonly api: Client["api"];

  constructor(baseUrl: string) {
    const client = hc<AppType>(baseUrl);
    this.api = client.api;
  }
}
