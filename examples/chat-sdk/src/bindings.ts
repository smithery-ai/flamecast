import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql, type SQLWrapper } from "drizzle-orm";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";

const BINDINGS_TABLE = "flamecast_chat_sdk_bindings";

export type ChatSdkThread = {
  id: string;
  post(message: string): Promise<unknown>;
  startTyping?(): Promise<unknown>;
  subscribe?(): Promise<unknown>;
  unsubscribe?(): Promise<unknown>;
};

export type ThreadAgentBinding = {
  threadId: string;
  agentId: string;
  authToken: string;
};

export type SqlThreadAgentBindingQueryResult =
  | Array<Record<string, unknown>>
  | { rows: Array<Record<string, unknown>> };

export type SqlThreadAgentBindingDatabase = {
  execute(statement: SQLWrapper): Promise<SqlThreadAgentBindingQueryResult>;
};

export type CreateSqlThreadAgentBindingStoreOptions = {
  database?: SqlThreadAgentBindingDatabase;
  pgliteDataDir?: string;
};

export class SqlThreadAgentBindingStore {
  private constructor(
    private readonly database: SqlThreadAgentBindingDatabase,
    private readonly closeDatabase?: () => Promise<void>,
  ) {}

  static async create(
    options: CreateSqlThreadAgentBindingStoreOptions = {},
  ): Promise<SqlThreadAgentBindingStore> {
    if (options.database) {
      const store = new SqlThreadAgentBindingStore(options.database);
      await store.ensureSchema();
      return store;
    }

    const dataDir = path.resolve(
      options.pgliteDataDir ?? path.join(process.cwd(), ".flamecast-chat-sdk", "pglite"),
    );
    await mkdir(dataDir, { recursive: true });
    const client = await PGlite.create(dataDir);
    const database = drizzlePgLite({ client });
    const store = new SqlThreadAgentBindingStore(database, async () => {
      await client.close();
    });
    await store.ensureSchema();
    return store;
  }

  async close(): Promise<void> {
    await this.closeDatabase?.();
  }

  async getByThreadId(threadId: string): Promise<ThreadAgentBinding | null> {
    return this.getOne(sql`
      select thread_id, agent_id, auth_token
      from ${sql.raw(BINDINGS_TABLE)}
      where thread_id = ${threadId}
    `);
  }

  async getByAgentId(agentId: string): Promise<ThreadAgentBinding | null> {
    return this.getOne(sql`
      select thread_id, agent_id, auth_token
      from ${sql.raw(BINDINGS_TABLE)}
      where agent_id = ${agentId}
    `);
  }

  async getByAuthToken(authToken: string): Promise<ThreadAgentBinding | null> {
    return this.getOne(sql`
      select thread_id, agent_id, auth_token
      from ${sql.raw(BINDINGS_TABLE)}
      where auth_token = ${authToken}
    `);
  }

  async set(binding: ThreadAgentBinding): Promise<void> {
    const now = new Date().toISOString();
    await this.database.execute(sql`
      insert into ${sql.raw(BINDINGS_TABLE)}
        (thread_id, agent_id, auth_token, created_at, updated_at)
      values
        (${binding.threadId}, ${binding.agentId}, ${binding.authToken}, ${now}, ${now})
      on conflict(thread_id) do update set
        agent_id = excluded.agent_id,
        auth_token = excluded.auth_token,
        updated_at = excluded.updated_at
    `);
  }

  async deleteByThreadId(threadId: string): Promise<ThreadAgentBinding | null> {
    const binding = await this.getByThreadId(threadId);
    if (!binding) {
      return null;
    }

    await this.database.execute(sql`
      delete from ${sql.raw(BINDINGS_TABLE)}
      where thread_id = ${threadId}
    `);
    return binding;
  }

  async list(): Promise<ThreadAgentBinding[]> {
    const result = await this.database.execute(sql`
      select thread_id, agent_id, auth_token
      from ${sql.raw(BINDINGS_TABLE)}
      order by created_at asc, thread_id asc
    `);
    return rowsFromResult(result).map((row) => toBinding(row));
  }

  async clear(): Promise<void> {
    await this.database.execute(sql`delete from ${sql.raw(BINDINGS_TABLE)}`);
  }

  private async ensureSchema(): Promise<void> {
    await this.database.execute(sql`
      create table if not exists ${sql.raw(BINDINGS_TABLE)} (
        thread_id text primary key,
        agent_id text not null unique,
        auth_token text not null unique,
        created_at text not null,
        updated_at text not null
      )
    `);
  }

  private async getOne(statement: SQLWrapper): Promise<ThreadAgentBinding | null> {
    const result = await this.database.execute(statement);
    const [row] = rowsFromResult(result);
    return row ? toBinding(row) : null;
  }
}

function rowsFromResult(result: SqlThreadAgentBindingQueryResult): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : result.rows;
}

function toBinding(row: Record<string, unknown>): ThreadAgentBinding {
  return {
    threadId: toStringColumn(row.thread_id, "thread_id"),
    agentId: toStringColumn(row.agent_id, "agent_id"),
    authToken: toStringColumn(row.auth_token, "auth_token"),
  };
}

function toStringColumn(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string`);
  }

  return value;
}
