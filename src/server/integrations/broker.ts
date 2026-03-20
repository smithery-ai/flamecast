import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { BrokerTokenScope, IntegrationProvider } from "@/shared/integrations.js";
import { BrokerTokenScopeSchema } from "@/shared/integrations.js";
import { getIntegrationConfig } from "./config.js";
import { ensureIntegrationTables, getIntegrationPool } from "./db.js";
import { getLinearAccessToken } from "./linear-client.js";
import { IntegrationStore, type StoredInstallSecret } from "./store.js";

const ProxyTokenPayloadSchema = z.object({
  expiresAt: z.string(),
  installId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  methods: z.array(z.string()).default(["GET", "POST"]),
  pathPrefixes: z.array(z.string()).default([]),
  services: z.array(z.enum(["slack", "linear"])).min(1),
});

type ProxyTokenPayload = z.infer<typeof ProxyTokenPayloadSchema>;

interface VerifiedProxyToken extends ProxyTokenPayload {
  tokenHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bearerToken(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function shouldForwardBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function serviceBaseUrl(service: IntegrationProvider): string {
  switch (service) {
    case "linear":
      return "https://api.linear.app";
    case "slack":
      return "https://slack.com";
  }
}

function matchesPathPrefixes(requestPath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) {
    return true;
  }
  return prefixes.some((prefix) => requestPath.startsWith(prefix));
}

function buildUpstreamUrl(service: IntegrationProvider, path: string, query: string): string {
  const base = serviceBaseUrl(service);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}${query}`;
}

function assertService(service: string): IntegrationProvider {
  if (service === "linear" || service === "slack") {
    return service;
  }
  throw new Error(`Unsupported service "${service}"`);
}

async function readRequestBody(request: Request): Promise<ArrayBuffer | undefined> {
  return shouldForwardBody(request.method) ? request.arrayBuffer() : undefined;
}

export class IntegrationBroker {
  constructor(private store: IntegrationStore) {}

  async mintToken(
    scope: {
      expiresAt?: string | Date;
      installId: string | null;
      metadata?: Record<string, unknown>;
      methods?: string[];
      pathPrefixes?: string[];
      services: IntegrationProvider[];
    },
  ): Promise<string> {
    const db = getIntegrationPool();
    if (!(await ensureIntegrationTables()) || !db) {
      throw new Error("Integration broker is not configured");
    }

    const expiresAt =
      scope.expiresAt instanceof Date
        ? scope.expiresAt.toISOString()
        : scope.expiresAt ?? new Date(Date.now() + 1000 * 60 * 15).toISOString();
    const parsedScope = BrokerTokenScopeSchema.parse({
      expiresAt,
      installId: scope.installId,
      methods: scope.methods,
      pathPrefixes: scope.pathPrefixes,
      services: scope.services,
    });

    const rawToken = `fcb_${randomBytes(24).toString("base64url")}`;
    const payload: ProxyTokenPayload = ProxyTokenPayloadSchema.parse({
      expiresAt: parsedScope.expiresAt,
      installId: parsedScope.installId,
      metadata: scope.metadata ?? {},
      methods: parsedScope.methods,
      pathPrefixes: parsedScope.pathPrefixes,
      services: parsedScope.services,
    });

    await db.query(
      `
      INSERT INTO broker_tokens (token_hash, install_id, services, methods, path_prefixes, metadata, expires_at)
      VALUES ($1, $2, $3::text[], $4::text[], $5::text[], $6::jsonb, $7::timestamptz)
      `,
      [
        sha256(rawToken),
        payload.installId,
        payload.services,
        payload.methods.map((method) => method.toUpperCase()),
        payload.pathPrefixes,
        JSON.stringify(payload.metadata),
        payload.expiresAt,
      ],
    );

    return rawToken;
  }

  async revokeToken(rawToken: string): Promise<void> {
    const db = getIntegrationPool();
    if (!(await ensureIntegrationTables()) || !db) {
      return;
    }
    await db.query(`UPDATE broker_tokens SET revoked_at = NOW() WHERE token_hash = $1`, [sha256(rawToken)]);
  }

  async verifyToken(rawToken: string): Promise<VerifiedProxyToken | null> {
    const db = getIntegrationPool();
    if (!(await ensureIntegrationTables()) || !db) {
      return null;
    }
    const result = await db.query(
      `
      SELECT install_id, services, methods, path_prefixes, metadata, expires_at
      FROM broker_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
      LIMIT 1
      `,
      [sha256(rawToken)],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const payload = ProxyTokenPayloadSchema.parse({
      expiresAt:
        row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      installId: typeof row.install_id === "string" ? row.install_id : null,
      metadata: row.metadata ?? {},
      methods: Array.isArray(row.methods) ? row.methods : [],
      pathPrefixes: Array.isArray(row.path_prefixes) ? row.path_prefixes : [],
      services: Array.isArray(row.services) ? row.services : [],
    });
    return {
      ...payload,
      tokenHash: sha256(rawToken),
    };
  }

  private async resolveBearerToken(
    service: IntegrationProvider,
    verified: VerifiedProxyToken,
  ): Promise<string | null> {
    if (service === "slack" && verified.installId) {
      const secret = await this.store.getInstallSecret(verified.installId);
      return secret?.token ?? null;
    }

    if (service === "linear" && verified.installId) {
      const secret = await this.store.getInstallSecret(verified.installId);
      if (secret?.token) {
        return secret.token;
      }
    }

    const config = getIntegrationConfig();
    if (service === "linear") {
      return getLinearAccessToken();
    }
    return null;
  }

  private async upstreamRequest(
    request: Request,
    service: IntegrationProvider,
    verified: VerifiedProxyToken,
    path: string,
  ): Promise<Response> {
    const token = await this.resolveBearerToken(service, verified);
    if (!token) {
      return new Response(
        JSON.stringify({ error: `No credential is available for service "${service}"` }),
        {
          headers: { "content-type": "application/json" },
          status: 503,
        },
      );
    }

    const requestUrl = new URL(request.url);
    const method = request.method.toUpperCase();
    if (!verified.services.includes(service)) {
      return new Response(JSON.stringify({ error: `Token does not allow service "${service}"` }), {
        headers: { "content-type": "application/json" },
        status: 403,
      });
    }
    if (!verified.methods.includes(method)) {
      return new Response(JSON.stringify({ error: `Token does not allow method "${method}"` }), {
        headers: { "content-type": "application/json" },
        status: 403,
      });
    }
    if (!matchesPathPrefixes(path, verified.pathPrefixes)) {
      return new Response(JSON.stringify({ error: `Token does not allow path "${path}"` }), {
        headers: { "content-type": "application/json" },
        status: 403,
      });
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("proxy-authorization");
    headers.set("authorization", `Bearer ${token}`);

    const upstream = await fetch(buildUpstreamUrl(service, path, requestUrl.search), {
      body: await readRequestBody(request.clone()),
      headers,
      method,
      redirect: "follow",
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new Response(upstream.body, {
      headers: responseHeaders,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  }

  async handleProxy(c: Context): Promise<Response> {
    if (!(await this.store.isEnabled())) {
      return c.json({ error: "Integration broker is not configured" }, 503);
    }

    const serviceParam = c.req.param("service");
    if (!serviceParam) {
      return c.json({ error: "Missing service" }, 400);
    }
    const service = assertService(serviceParam);
    const rawToken = bearerToken(c.req.header("proxy-authorization"));
    if (!rawToken) {
      return c.json({ error: "Missing Proxy-Authorization bearer token" }, 401);
    }

    const verified = await this.verifyToken(rawToken);
    if (!verified) {
      return c.json({ error: "Invalid or expired proxy token" }, 401);
    }

    const wildcard = c.req.param("*") ?? "";
    const path = wildcard.startsWith("/") ? wildcard : `/${wildcard}`;
    return this.upstreamRequest(c.req.raw, service, verified, path);
  }
}

export function createIntegrationProxyRoutes(broker: IntegrationBroker): Hono {
  return new Hono().all("/proxy/:service/*", async (c) => broker.handleProxy(c));
}

export function makeBearerInstallSecret(token: string): StoredInstallSecret {
  return {
    token,
    type: "bearer",
  };
}
