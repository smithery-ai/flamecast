CREATE SCHEMA IF NOT EXISTS "flamecast";
--> statement-breakpoint
CREATE TABLE "flamecast"."agent_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flamecast"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"pending_permission" jsonb,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_templates_list" ON "flamecast"."agent_templates" USING btree ("managed","sort_order","created_at","id");