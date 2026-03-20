import {
  bigint,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AgentSpawn, PendingPermission } from "../../../shared/connection.js";

export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  agentLabel: text("agent_label").notNull(),
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

export const chatStateKv = pgTable("chat_state_kv", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }),
});

export const chatStateSubscriptions = pgTable("chat_state_subscriptions", {
  threadId: text("thread_id").primaryKey(),
});

export const chatStateLocks = pgTable("chat_state_locks", {
  threadId: text("thread_id").primaryKey(),
  token: text("token").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const slackWorkspaceInstalls = pgTable("slack_workspace_installs", {
  teamId: text("team_id").primaryKey(),
  installedAt: timestamp("installed_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const slackConnectionBindings = pgTable(
  "slack_connection_bindings",
  {
    connectionId: text("connection_id").primaryKey(),
    connectionSessionId: text("connection_session_id").notNull(),
    teamId: text("team_id").notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [uniqueIndex("idx_slack_connection_bindings_team").on(t.teamId)],
);
