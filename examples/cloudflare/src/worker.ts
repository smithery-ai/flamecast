import { handleRequest } from "./app.js";
import agentSource from "../agent-source.txt";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env.HYPERDRIVE.connectionString, {
      e2bApiKey: env.E2B_API_KEY,
      agentSource,
    });
  },
};
