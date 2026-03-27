import { getFlamecast } from "../src/app.js";

const healthPathnames = new Set(["/health", "/api/health"]);

export default async function handler(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  try {
    const flamecast = await getFlamecast();
    return flamecast.app.fetch(request);
  } catch (error) {
    if (healthPathnames.has(pathname)) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return Response.json({ status: "degraded", error: message }, { status: 503 });
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
