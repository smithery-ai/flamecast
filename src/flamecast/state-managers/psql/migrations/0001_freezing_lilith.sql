CREATE TABLE IF NOT EXISTS "chat_state_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_state_locks" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_state_subscriptions" (
	"thread_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_connection_bindings" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"connection_session_id" text NOT NULL,
	"team_id" text NOT NULL,
	"bound_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_workspace_installs" (
	"team_id" text PRIMARY KEY NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_connection_bindings_team" ON "slack_connection_bindings" USING btree ("team_id");
