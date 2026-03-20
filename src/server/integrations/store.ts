import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type ConversationBinding,
  ConversationBindingSchema,
  type ConversationSource,
  ConversationSourceSchema,
  type IntegrationInstall,
  IntegrationInstallSchema,
  type IntegrationProvider,
  type TranscriptEvent,
  TranscriptEventSchema,
} from "@/shared/integrations.js";
import { decryptJson, encryptJson, type SealedValue } from "./crypto.js";
import { ensureIntegrationTables, getIntegrationPool } from "./db.js";

const JsonRecordSchema = z.record(z.string(), z.unknown());

const StoredInstallSecretSchema = z.object({
  token: z.string(),
  type: z.literal("bearer"),
});

export type StoredInstallSecret = z.infer<typeof StoredInstallSecretSchema>;

function toJsonRecord(value: unknown): Record<string, unknown> {
  return JsonRecordSchema.parse(value ?? {});
}

function toIsoString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new Error("Expected timestamp value");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseInstallRow(row: Record<string, unknown>): IntegrationInstall {
  return IntegrationInstallSchema.parse({
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    label: row.label,
    metadata: toJsonRecord(row.metadata),
    hasCredential: Boolean(row.credentials_ciphertext),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

function parseBindingRow(row: Record<string, unknown>): ConversationBinding {
  const source = ConversationSourceSchema.parse({
    platform: row.platform,
    threadId: row.thread_id,
    installId: optionalString(row.install_id),
    externalWorkspaceId: optionalString(row.external_workspace_id),
    externalThreadLabel: optionalString(row.external_thread_label),
  });
  return ConversationBindingSchema.parse({
    id: row.id,
    source,
    connectionId: optionalString(row.connection_id),
    sessionId: optionalString(row.session_id),
    metadata: toJsonRecord(row.metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

function parseTranscriptRow(row: Record<string, unknown>): TranscriptEvent {
  return TranscriptEventSchema.parse({
    id: row.id,
    bindingId: row.binding_id,
    kind: row.kind,
    payload: toJsonRecord(row.payload),
    createdAt: toIsoString(row.created_at),
  });
}

function toSealedValue(row: Record<string, unknown>): SealedValue | null {
  if (
    typeof row.credentials_ciphertext !== "string" ||
    typeof row.credentials_iv !== "string" ||
    typeof row.credentials_tag !== "string"
  ) {
    return null;
  }
  return {
    ciphertext: row.credentials_ciphertext,
    iv: row.credentials_iv,
    tag: row.credentials_tag,
  };
}

export class IntegrationStore {
  constructor(private encryptionKey: string | null) {}

  private requireEncryptionKey(): string {
    if (!this.encryptionKey) {
      throw new Error("FLAMECAST_BROKER_ENCRYPTION_KEY is required for credential storage");
    }
    return this.encryptionKey;
  }

  async isEnabled(): Promise<boolean> {
    return ensureIntegrationTables();
  }

  async upsertInstall(input: {
    credential?: StoredInstallSecret | null;
    externalId: string;
    label: string;
    metadata?: Record<string, unknown>;
    provider: IntegrationProvider;
  }): Promise<IntegrationInstall> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      throw new Error("Integration storage is not configured");
    }

    const sealed = input.credential
      ? encryptJson(input.credential, this.requireEncryptionKey())
      : null;

    const result = await db.query(
      `
      INSERT INTO integration_installs (
        id,
        provider,
        external_id,
        label,
        credentials_ciphertext,
        credentials_iv,
        credentials_tag,
        metadata,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
      ON CONFLICT (provider, external_id)
      DO UPDATE SET
        label = EXCLUDED.label,
        credentials_ciphertext = COALESCE(EXCLUDED.credentials_ciphertext, integration_installs.credentials_ciphertext),
        credentials_iv = COALESCE(EXCLUDED.credentials_iv, integration_installs.credentials_iv),
        credentials_tag = COALESCE(EXCLUDED.credentials_tag, integration_installs.credentials_tag),
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
      `,
      [
        randomUUID(),
        input.provider,
        input.externalId,
        input.label,
        sealed?.ciphertext ?? null,
        sealed?.iv ?? null,
        sealed?.tag ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to store integration install");
    }
    return parseInstallRow(row);
  }

  async getInstallById(id: string): Promise<IntegrationInstall | null> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      return null;
    }
    const result = await db.query(`SELECT * FROM integration_installs WHERE id = $1 LIMIT 1`, [id]);
    const row = result.rows[0];
    return row ? parseInstallRow(row) : null;
  }

  async getInstallByProviderExternalId(
    provider: IntegrationProvider,
    externalId: string,
  ): Promise<IntegrationInstall | null> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      return null;
    }
    const result = await db.query(
      `SELECT * FROM integration_installs WHERE provider = $1 AND external_id = $2 LIMIT 1`,
      [provider, externalId],
    );
    const row = result.rows[0];
    return row ? parseInstallRow(row) : null;
  }

  async getInstallSecret(id: string): Promise<StoredInstallSecret | null> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      return null;
    }
    const result = await db.query(
      `SELECT credentials_ciphertext, credentials_iv, credentials_tag FROM integration_installs WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    const sealed = row ? toSealedValue(row) : null;
    if (!sealed) {
      return null;
    }
    return decryptJson(sealed, this.requireEncryptionKey(), (input) =>
      StoredInstallSecretSchema.parse(input),
    );
  }

  async listInstalls(): Promise<IntegrationInstall[]> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      return [];
    }
    const result = await db.query(`SELECT * FROM integration_installs ORDER BY updated_at DESC`);
    return result.rows.map((row) => parseInstallRow(row));
  }

  async findOrCreateBinding(input: {
    metadata?: Record<string, unknown>;
    source: ConversationSource;
  }): Promise<ConversationBinding> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      throw new Error("Integration storage is not configured");
    }

    const existing = await db.query(
      `SELECT * FROM conversation_bindings WHERE platform = $1 AND thread_id = $2 LIMIT 1`,
      [input.source.platform, input.source.threadId],
    );
    const row = existing.rows[0];
    if (row) {
      return parseBindingRow(row);
    }

    const created = await db.query(
      `
      INSERT INTO conversation_bindings (
        id,
        platform,
        thread_id,
        install_id,
        external_workspace_id,
        external_thread_label,
        metadata,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
      RETURNING *
      `,
      [
        randomUUID(),
        input.source.platform,
        input.source.threadId,
        input.source.installId,
        input.source.externalWorkspaceId,
        input.source.externalThreadLabel,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const createdRow = created.rows[0];
    if (!createdRow) {
      throw new Error("Failed to create conversation binding");
    }
    return parseBindingRow(createdRow);
  }

  async updateBindingSession(
    bindingId: string,
    session: {
      connectionId: string | null;
      metadata?: Record<string, unknown>;
      sessionId: string | null;
    },
  ): Promise<ConversationBinding> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      throw new Error("Integration storage is not configured");
    }
    const result = await db.query(
      `
      UPDATE conversation_bindings
      SET connection_id = $2,
          session_id = $3,
          metadata = COALESCE($4::jsonb, metadata),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [bindingId, session.connectionId, session.sessionId, session.metadata ? JSON.stringify(session.metadata) : null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Conversation binding "${bindingId}" not found`);
    }
    return parseBindingRow(row);
  }

  async appendTranscript(
    bindingId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<TranscriptEvent> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      throw new Error("Integration storage is not configured");
    }
    const result = await db.query(
      `
      INSERT INTO transcript_events (id, binding_id, kind, payload, created_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      RETURNING *
      `,
      [randomUUID(), bindingId, kind, JSON.stringify(payload)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to append transcript event");
    }
    return parseTranscriptRow(row);
  }

  async listTranscript(bindingId: string, limit = 50): Promise<TranscriptEvent[]> {
    const db = getIntegrationPool();
    if (!(await this.isEnabled()) || !db) {
      return [];
    }
    const result = await db.query(
      `
      SELECT * FROM transcript_events
      WHERE binding_id = $1
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [bindingId, limit],
    );
    return result.rows.map((row) => parseTranscriptRow(row));
  }
}
