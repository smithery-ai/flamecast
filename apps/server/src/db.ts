import { sql } from "drizzle-orm";
import { createDatabase, createStorageFromDb } from "@flamecast/storage-psql";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

const { db, close } = await createDatabase(url ? { url } : {});

// Auto-create the better-auth tables in the "auth" schema (idempotent).
await db.execute(sql`CREATE SCHEMA IF NOT EXISTS auth`);
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS auth."user" (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    image TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`);
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS auth.session (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES auth."user"(id),
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`);
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS auth.account (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES auth."user"(id),
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    access_token_expires_at TIMESTAMP,
    refresh_token_expires_at TIMESTAMP,
    scope TEXT,
    id_token TEXT,
    password TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`);
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS auth.verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )
`);

export { db, close };
export const storage = createStorageFromDb(db);
