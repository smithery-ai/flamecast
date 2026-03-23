import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  AgentSpawn,
  AgentTemplateRuntime,
  PendingPermission,
} from "@flamecast/sdk/shared/session";

export const flamecastSchema = pgSchema("flamecast");

export const sessions = flamecastSchema.table("sessions", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  spawn: jsonb("spawn").$type<AgentSpawn>().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "string" }).notNull(),
  pendingPermission: jsonb("pending_permission").$type<PendingPermission | null>(),
  status: text("status").notNull().default("active"),
});

export const agentTemplates = flamecastSchema.table(
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
