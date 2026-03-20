CREATE TABLE "connection_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"session_id" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_label" text NOT NULL,
	"spawn" jsonb NOT NULL,
	"session_id" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"pending_permission" jsonb,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connection_logs_conn" ON "connection_logs" USING btree ("connection_id","id");