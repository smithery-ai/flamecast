import { getFlamecast } from "../src/app.js";

const healthPathnames = new Set(["/health", "/api/health"]);

export default async function handler(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (healthPathnames.has(pathname)) {
    return Response.json({ status: "ok", route: pathname }, { status: 200 });
  }

  try {
    const flamecast = await getFlamecast();
    return flamecast.app.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
