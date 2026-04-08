CREATE TABLE tunnels (
  name TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL,
  tunnel_token TEXT NOT NULL,
  dns_record_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
