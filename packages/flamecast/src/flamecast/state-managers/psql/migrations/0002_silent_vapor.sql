CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"latest_session_id" text,
	"session_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
DELETE FROM "session_logs";
--> statement-breakpoint
DELETE FROM "sessions";
--> statement-breakpoint
ALTER TABLE "agent_templates" ALTER COLUMN "managed" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "agent_templates" ALTER COLUMN "sort_order" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cwd" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sessions_agent" ON "sessions" USING btree ("agent_id","last_updated_at","id");
