import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  AgentSpawn,
  AgentTemplateRuntime,
  PendingPermission,
} from "../../../shared/session.js";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  spawn: jsonb("spawn").$type<AgentSpawn>().notNull(),
  runtime: jsonb("runtime").$type<AgentTemplateRuntime>().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "string" }).notNull(),
  latestSessionId: text("latest_session_id"),
  sessionCount: integer("session_count").notNull().default(0),
  status: text("status").notNull().default("active"),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    spawn: jsonb("spawn").$type<AgentSpawn>().notNull(),
    cwd: text("cwd").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "string" }).notNull(),
    pendingPermission: jsonb("pending_permission").$type<PendingPermission | null>(),
    status: text("status").notNull().default("active"),
  },
  (t) => [index("idx_sessions_agent").on(t.agentId, t.lastUpdatedAt, t.id)],
);

export const sessionLogs = pgTable(
  "session_logs",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("idx_session_logs_session").on(t.sessionId, t.id)],
);

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    spawn: jsonb("spawn").$type<AgentSpawn>().notNull(),
    runtime: jsonb("runtime").$type<AgentTemplateRuntime>().notNull(),
    managed: boolean("managed").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_agent_templates_list").on(t.managed, t.sortOrder, t.createdAt, t.id)],
);
