/**
 * Flamecast Worker — Cloudflare Workers entry point.
 *
 * Same Hono app as the Node and Vercel entry points.
 */
import { Flamecast, E2BRuntime } from "@flamecast/sdk";
import { createPsqlStorage } from "@flamecast/storage-psql";

const flamecast = new Flamecast({
  storage: await createPsqlStorage({ url: process.env.DATABASE_URL ?? "" }),
  runtimes: {
    default: new E2BRuntime({ apiKey: process.env.E2B_API_KEY ?? "" }),
  },
});

export default flamecast.app;
