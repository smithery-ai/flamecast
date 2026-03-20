import { Pool } from "pg";
import { getIntegrationConfig } from "./config.js";

let pool: Pool | null = null;
let bootstrapped = false;

export function getIntegrationPool(): Pool | null {
  const config = getIntegrationConfig();
  if (!config.postgresUrl) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.postgresUrl,
    });
  }
  return pool;
}

export async function ensureIntegrationTables(): Promise<boolean> {
  const db = getIntegrationPool();
  if (!db || bootstrapped) {
    return Boolean(db);
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS integration_installs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      label TEXT NOT NULL,
      credentials_ciphertext TEXT,
      credentials_iv TEXT,
      credentials_tag TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS integration_installs_provider_external_id_idx
    ON integration_installs (provider, external_id);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_bindings (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      install_id TEXT REFERENCES integration_installs(id) ON DELETE SET NULL,
      external_workspace_id TEXT,
      external_thread_label TEXT,
      connection_id TEXT,
      session_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_bindings_platform_thread_id_idx
    ON conversation_bindings (platform, thread_id);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS transcript_events (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES conversation_bindings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS transcript_events_binding_id_created_at_idx
    ON transcript_events (binding_id, created_at);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS broker_tokens (
      token_hash TEXT PRIMARY KEY,
      install_id TEXT REFERENCES integration_installs(id) ON DELETE CASCADE,
      services TEXT[] NOT NULL,
      methods TEXT[] NOT NULL,
      path_prefixes TEXT[] NOT NULL DEFAULT '{}'::text[],
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS broker_tokens_install_id_idx
    ON broker_tokens (install_id);
  `);

  bootstrapped = true;
  return true;
}
