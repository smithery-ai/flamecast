import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { AgentSpawn, PendingPermission } from "../../../shared/session.js";

export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  agentName: text("agent_label").notNull(),
  spawn: jsonb("spawn").$type<AgentSpawn>().notNull(),
  sessionId: text("session_id").notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "string" }).notNull(),
  pendingPermission: jsonb("pending_permission").$type<PendingPermission | null>(),
  status: text("status").notNull().default("active"),
});

export const connectionLogs = pgTable(
  "connection_logs",
  {
    id: serial("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("idx_connection_logs_conn").on(t.connectionId, t.id)],
);
