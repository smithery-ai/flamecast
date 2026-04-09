import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  AgentSpawn,
  AgentTemplateRuntime,
  PendingPermission,
  WebhookConfig,
} from "@flamecast/protocol/session";

export const flamecastSchema = pgSchema("flamecast");

export const sessions = flamecastSchema.table("sessions", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  spawn: jsonb("spawn").$type<AgentSpawn>().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "string" }).notNull(),
  pendingPermission: jsonb("pending_permission").$type<PendingPermission | null>(),
  status: text("status").notNull().default("active"),
  hostUrl: text("host_url"),
  websocketUrl: text("websocket_url"),
  runtimeName: text("runtime_name"),
  runtimeMeta: jsonb("runtime_meta").$type<Record<string, unknown> | null>(),
  runtime: text("runtime"),
  cwd: text("cwd"),
  title: text("title"),
  webhooks: jsonb("webhooks").$type<WebhookConfig[] | null>(),
});

export const agentTemplates = flamecastSchema.table(
  "agent_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    setup: text("setup"),
    env: jsonb("env").$type<Record<string, string>>(),
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

export const messageQueue = flamecastSchema.table(
  "message_queue",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id"),
    text: text("text").notNull(),
    runtime: text("runtime").notNull(),
    agent: text("agent").notNull(),
    agentTemplateId: text("agent_template_id"),
    directory: text("directory"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [index("idx_message_queue_pending").on(t.sessionId, t.status, t.createdAt)],
);

export const runtimeInstances = flamecastSchema.table("runtime_instances", {
  name: text("name").primaryKey(),
  typeName: text("type_name").notNull(),
  status: text("status").notNull().default("running"),
  websocketUrl: text("websocket_url"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
