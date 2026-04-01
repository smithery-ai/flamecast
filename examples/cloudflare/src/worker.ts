import { handleRequest } from "./app.js";
import agentSource from "../agent-source.txt";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight before touching DB/runtime so it never fails.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      return await handleRequest(request, {
        e2bApiKey: env.E2B_API_KEY,
        agentSource,
        restateUrl: env.RESTATE_INGRESS_URL,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[worker] Unhandled error:", message, err instanceof Error ? err.stack : "");
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};
