import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Lock, StateAdapter } from "chat";
import {
  chatStateKv,
  chatStateLocks,
  chatStateSubscriptions,
} from "@/flamecast/state-managers/psql/schema.js";
import type { AppDb } from "../db/client.js";

type TransactionDb = Pick<AppDb, "delete" | "insert" | "select" | "update">;

function toExpiresAt(ttlMs?: number): number | null {
  return ttlMs ? Date.now() + ttlMs : null;
}

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function deserialize<T>(valueJson: string): T {
  return JSON.parse(valueJson);
}

export class DbStateAdapter implements StateAdapter {
  private connected = false;

  constructor(private readonly db: AppDb) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.db.insert(chatStateSubscriptions).values({ threadId }).onConflictDoNothing();
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.db
      .delete(chatStateSubscriptions)
      .where(eq(chatStateSubscriptions.threadId, threadId));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const rows = await this.db
      .select({ threadId: chatStateSubscriptions.threadId })
      .from(chatStateSubscriptions)
      .where(eq(chatStateSubscriptions.threadId, threadId))
      .limit(1);
    return rows.length > 0;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();

    const now = Date.now();
    const lock: Lock = {
      expiresAt: now + ttlMs,
      threadId,
      token: randomUUID(),
    };

    return this.transaction(async (tx) => {
      const existing = await this.readLockRow(tx, threadId);
      if (existing && existing.expiresAt > now) {
        return null;
      }

      if (existing) {
        await tx
          .update(chatStateLocks)
          .set({ expiresAt: lock.expiresAt, token: lock.token })
          .where(eq(chatStateLocks.threadId, threadId));
      } else {
        await tx.insert(chatStateLocks).values(lock);
      }

      return lock;
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.db.delete(chatStateLocks).where(eq(chatStateLocks.threadId, threadId));
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    await this.db
      .delete(chatStateLocks)
      .where(and(eq(chatStateLocks.threadId, lock.threadId), eq(chatStateLocks.token, lock.token)));
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();

    const now = Date.now();
    const expiresAt = now + ttlMs;
    const rows = await this.db
      .update(chatStateLocks)
      .set({ expiresAt })
      .where(
        and(
          eq(chatStateLocks.threadId, lock.threadId),
          eq(chatStateLocks.token, lock.token),
          gt(chatStateLocks.expiresAt, now),
        ),
      )
      .returning();

    if (rows.length === 0) {
      return false;
    }

    lock.expiresAt = expiresAt;
    return true;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();

    const row = await this.readCacheRow(this.db, key);
    return row ? deserialize<T>(row.valueJson) : null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();
    await this.upsertCacheRow(this.db, key, value, toExpiresAt(ttlMs));
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    this.ensureConnected();

    return this.transaction(async (tx) => {
      const existing = await this.readCacheRow(tx, key);
      if (existing) {
        return false;
      }

      await this.upsertCacheRow(tx, key, value, toExpiresAt(ttlMs));
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.db.delete(chatStateKv).where(eq(chatStateKv.key, key));
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    this.ensureConnected();

    await this.transaction(async (tx) => {
      const existing = await this.readCacheRow(tx, key);
      const current = existing ? deserialize<unknown>(existing.valueJson) : [];
      const list = Array.isArray(current) ? [...current] : [];
      list.push(value);

      const trimmed =
        options?.maxLength && list.length > options.maxLength
          ? list.slice(list.length - options.maxLength)
          : list;

      await this.upsertCacheRow(tx, key, trimmed, toExpiresAt(options?.ttlMs));
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();

    const row = await this.readCacheRow(this.db, key);
    if (!row) {
      return [];
    }

    const current = JSON.parse(row.valueJson);
    return Array.isArray(current) ? current : [];
  }

  private async transaction<T>(run: (tx: TransactionDb) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => run(tx));
  }

  private async readCacheRow(db: TransactionDb, key: string) {
    const rows = await db.select().from(chatStateKv).where(eq(chatStateKv.key, key)).limit(1);
    const row = rows[0];

    if (!row) {
      return null;
    }

    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      await db.delete(chatStateKv).where(eq(chatStateKv.key, key));
      return null;
    }

    return row;
  }

  private async upsertCacheRow(
    db: TransactionDb,
    key: string,
    value: unknown,
    expiresAt: number | null,
  ): Promise<void> {
    await db
      .insert(chatStateKv)
      .values({ expiresAt, key, valueJson: serialize(value) })
      .onConflictDoUpdate({
        target: chatStateKv.key,
        set: { expiresAt, valueJson: serialize(value) },
      });
  }

  private async readLockRow(db: TransactionDb, threadId: string) {
    const rows = await db
      .select()
      .from(chatStateLocks)
      .where(eq(chatStateLocks.threadId, threadId))
      .limit(1);
    return rows[0] ?? null;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("DbStateAdapter is not connected. Call connect() first.");
    }
  }
}

export function createDbState(db: AppDb): DbStateAdapter {
  return new DbStateAdapter(db);
}
