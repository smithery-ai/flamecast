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
INSERT INTO "agents" ("id", "agent_name", "spawn", "runtime", "started_at", "last_updated_at", "latest_session_id", "session_count", "status")
SELECT
	"id",
	"agent_name",
	"spawn",
	'{"provider":"local"}'::jsonb,
	"started_at",
	"last_updated_at",
	"id",
	1,
	"status"
FROM "sessions";
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cwd" text;
--> statement-breakpoint
UPDATE "sessions" SET "agent_id" = "id", "cwd" = '.';
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "agent_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "cwd" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_sessions_agent" ON "sessions" USING btree ("agent_id","last_updated_at","id");
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "agent_name";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "spawn";
