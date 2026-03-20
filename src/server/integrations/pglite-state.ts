import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Lock, StateAdapter } from "chat";

interface CacheRow {
  expiresAt: number | null;
  valueJson: string;
}

function defaultDataDir(): string {
  const resolved = path.resolve(
    process.cwd(),
    process.env.FLAMECAST_PGLITE_DIR?.trim() || ".flamecast/pglite",
  );
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function toExpiresAt(ttlMs?: number): number | null {
  return ttlMs ? Date.now() + ttlMs : null;
}

function coerceExpiresAt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function deserialize<T>(valueJson: string): T {
  return JSON.parse(valueJson) as T;
}

export class PGliteStateAdapter implements StateAdapter {
  private readonly db: PGlite;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(dataDir = defaultDataDir()) {
    this.db = new PGlite(dataDir);
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        await this.db.waitReady;
        await this.db.exec(`
          create table if not exists chat_state_kv (
            key text primary key,
            value_json text not null,
            expires_at bigint
          );

          create table if not exists chat_state_subscriptions (
            thread_id text primary key
          );

          create table if not exists chat_state_locks (
            thread_id text primary key,
            token text not null,
            expires_at bigint not null
          );
        `);
        this.connected = true;
      })();
    }

    await this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.db.query(
      `insert into chat_state_subscriptions (thread_id) values ($1)
       on conflict (thread_id) do nothing`,
      [threadId],
    );
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.db.query(`delete from chat_state_subscriptions where thread_id = $1`, [threadId]);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const result = await this.db.query<{ threadId: string }>(
      `select thread_id as "threadId" from chat_state_subscriptions where thread_id = $1`,
      [threadId],
    );
    return result.rows.length > 0;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();

    const now = Date.now();
    const lock: Lock = {
      expiresAt: now + ttlMs,
      threadId,
      token: randomUUID(),
    };

    const result = await this.db.query<{ threadId: string }>(
      `insert into chat_state_locks (thread_id, token, expires_at)
       values ($1, $2, $3)
       on conflict (thread_id) do update
       set token = excluded.token,
           expires_at = excluded.expires_at
       where chat_state_locks.expires_at <= $4
       returning thread_id as "threadId"`,
      [lock.threadId, lock.token, lock.expiresAt, now],
    );

    return result.rows.length > 0 ? lock : null;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.db.query(`delete from chat_state_locks where thread_id = $1`, [threadId]);
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    await this.db.query(
      `delete from chat_state_locks where thread_id = $1 and token = $2`,
      [lock.threadId, lock.token],
    );
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();

    const now = Date.now();
    const expiresAt = now + ttlMs;
    const result = await this.db.query<{ threadId: string }>(
      `update chat_state_locks
       set expires_at = $3
       where thread_id = $1 and token = $2 and expires_at > $4
       returning thread_id as "threadId"`,
      [lock.threadId, lock.token, expiresAt, now],
    );

    if (result.rows.length === 0) {
      return false;
    }

    lock.expiresAt = expiresAt;
    return true;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();

    const row = await this.readCacheRow(key);
    if (!row) {
      return null;
    }

    return deserialize<T>(row.valueJson);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();

    await this.db.query(
      `insert into chat_state_kv (key, value_json, expires_at)
       values ($1, $2, $3)
       on conflict (key) do update
       set value_json = excluded.value_json,
           expires_at = excluded.expires_at`,
      [key, serialize(value), toExpiresAt(ttlMs)],
    );
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    this.ensureConnected();

    const now = Date.now();
    const result = await this.db.query<{ key: string }>(
      `insert into chat_state_kv (key, value_json, expires_at)
       values ($1, $2, $3)
       on conflict (key) do update
       set value_json = excluded.value_json,
           expires_at = excluded.expires_at
       where chat_state_kv.expires_at is not null and chat_state_kv.expires_at <= $4
       returning key`,
      [key, serialize(value), toExpiresAt(ttlMs), now],
    );

    return result.rows.length > 0;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.db.query(`delete from chat_state_kv where key = $1`, [key]);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    this.ensureConnected();

    await this.db.transaction(async (tx) => {
      const row = await this.readCacheRow(key, tx);
      const list = row ? deserialize<unknown[]>(row.valueJson) : [];
      list.push(value);

      const trimmed =
        options?.maxLength && list.length > options.maxLength
          ? list.slice(list.length - options.maxLength)
          : list;

      await tx.query(
        `insert into chat_state_kv (key, value_json, expires_at)
         values ($1, $2, $3)
         on conflict (key) do update
         set value_json = excluded.value_json,
             expires_at = excluded.expires_at`,
        [key, serialize(trimmed), toExpiresAt(options?.ttlMs)],
      );
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();

    const row = await this.readCacheRow(key);
    if (!row) {
      return [];
    }

    const value = deserialize<unknown>(row.valueJson);
    return Array.isArray(value) ? (value as T[]) : [];
  }

  private async readCacheRow(
    key: string,
    db: Pick<PGlite, "query"> = this.db,
  ): Promise<CacheRow | null> {
    const result = await db.query<{ expiresAt: number | string | null; valueJson: string }>(
      `select expires_at as "expiresAt", value_json as "valueJson"
       from chat_state_kv
       where key = $1`,
      [key],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const expiresAt = coerceExpiresAt(row.expiresAt);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      await this.db.query(`delete from chat_state_kv where key = $1`, [key]);
      return null;
    }

    return {
      expiresAt,
      valueJson: row.valueJson,
    };
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("PGliteStateAdapter is not connected. Call connect() first.");
    }
  }
}

export function createPGliteState(dataDir?: string): PGliteStateAdapter {
  return new PGliteStateAdapter(dataDir);
}
