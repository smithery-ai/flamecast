import { boolean, index, integer, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AgentSpawn,
  AgentTemplateRuntime,
  PendingPermission,
  WebhookConfig,
} from "@flamecast/sdk";

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

export const runtimeInstances = flamecastSchema.table("runtime_instances", {
  name: text("name").primaryKey(),
  typeName: text("type_name").notNull(),
  status: text("status").notNull().default("running"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
