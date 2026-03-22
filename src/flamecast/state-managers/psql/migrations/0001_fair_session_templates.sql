CREATE TABLE "agent_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_logs" DROP CONSTRAINT "connection_logs_connection_id_connections_id_fk";
--> statement-breakpoint
DROP INDEX "idx_connection_logs_conn";
--> statement-breakpoint
ALTER TABLE "connection_logs" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "connections" RENAME TO "sessions";
--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "agent_label" TO "agent_name";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "session_id";
--> statement-breakpoint
ALTER TABLE "connection_logs" RENAME TO "session_logs";
--> statement-breakpoint
ALTER TABLE "session_logs" RENAME COLUMN "connection_id" TO "session_id";
--> statement-breakpoint
ALTER TABLE "session_logs" ADD CONSTRAINT "session_logs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_session_logs_session" ON "session_logs" USING btree ("session_id","id");
--> statement-breakpoint
CREATE INDEX "idx_agent_templates_list" ON "agent_templates" USING btree ("managed","sort_order","created_at","id");
