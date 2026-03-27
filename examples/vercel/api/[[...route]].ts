import { getFlamecast } from "../src/app.js";

export default async function handler(request: Request): Promise<Response> {
  const flamecast = await getFlamecast();
  return flamecast.app.fetch(request);
}
