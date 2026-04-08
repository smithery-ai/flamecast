export type Env = {
  DB: D1Database;

  // Secrets (set via `wrangler secret put`):
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
};

export type TunnelRow = {
  name: string;
  tunnel_id: string;
  tunnel_token: string;
  dns_record_id: string;
  created_at: string;
};
