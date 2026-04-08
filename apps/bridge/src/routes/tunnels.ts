import { Hono } from "hono";
import type { Env, TunnelRow } from "../types.js";
import {
  createTunnel,
  configureTunnelIngress,
  createDnsRecord,
  deleteTunnel,
  deleteDnsRecord,
} from "../lib/cloudflare-api.js";

const tunnels = new Hono<{ Bindings: Env }>();

tunnels.post("/", async (c) => {
  const body = await c.req.json<{ name: string; port?: number }>();
  const name = body.name?.toLowerCase();
  const port = body.port ?? 3001;

  if (!name || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) {
    return c.json(
      { error: "Invalid name. Use 3-32 lowercase letters, numbers, and hyphens." },
      400,
    );
  }

  // Check if name is already taken
  const existing = await c.env.DB.prepare("SELECT * FROM tunnels WHERE name = ?")
    .bind(name)
    .first<TunnelRow>();
  if (existing) {
    // Re-configure ingress in case the port changed
    await configureTunnelIngress(
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      existing.tunnel_id,
      `${name}.flamecast.app`,
      port,
    );
    return c.json({
      tunnelToken: existing.tunnel_token,
      domain: `${name}.flamecast.app`,
    });
  }

  const hostname = `${name}.flamecast.app`;

  const { tunnelId, tunnelToken } = await createTunnel(
    c.env.CF_ACCOUNT_ID,
    c.env.CF_API_TOKEN,
    `flamecast-${name}`,
  );

  await configureTunnelIngress(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, tunnelId, hostname, port);

  const dnsRecordId = await createDnsRecord(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, name, tunnelId);

  await c.env.DB.prepare(
    "INSERT INTO tunnels (name, tunnel_id, tunnel_token, dns_record_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(name, tunnelId, tunnelToken, dnsRecordId, new Date().toISOString())
    .run();

  return c.json({ tunnelToken, domain: hostname });
});

tunnels.delete("/:name", async (c) => {
  const name = c.req.param("name");

  const row = await c.env.DB.prepare("SELECT * FROM tunnels WHERE name = ?")
    .bind(name)
    .first<TunnelRow>();
  if (!row) {
    return c.json({ error: "Tunnel not found" }, 404);
  }

  await deleteDnsRecord(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, row.dns_record_id).catch(() => {});
  await deleteTunnel(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, row.tunnel_id).catch(() => {});
  await c.env.DB.prepare("DELETE FROM tunnels WHERE name = ?").bind(name).run();

  return c.json({ ok: true });
});

tunnels.get("/:name", async (c) => {
  const name = c.req.param("name");

  const row = await c.env.DB.prepare("SELECT * FROM tunnels WHERE name = ?")
    .bind(name)
    .first<TunnelRow>();
  if (!row) {
    return c.json({ error: "Tunnel not found" }, 404);
  }

  return c.json({
    name: row.name,
    domain: `${row.name}.flamecast.app`,
    createdAt: row.created_at,
  });
});

export { tunnels };
