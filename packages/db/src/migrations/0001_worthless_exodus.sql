CREATE TABLE "flamecast"."chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"repo" text,
	"source_repo_id" uuid,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flamecast"."workflow_runs" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "flamecast"."chats" ADD CONSTRAINT "chats_source_repo_id_user_source_repos_id_fk" FOREIGN KEY ("source_repo_id") REFERENCES "flamecast"."user_source_repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flamecast_chats_user_id_idx" ON "flamecast"."chats" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "flamecast_chats_repo_idx" ON "flamecast"."chats" USING btree ("repo");--> statement-breakpoint
ALTER TABLE "flamecast"."workflow_runs" ADD CONSTRAINT "workflow_runs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "flamecast"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flamecast_workflow_runs_chat_id_idx" ON "flamecast"."workflow_runs" USING btree ("chat_id");--> statement-breakpoint
-- Backfill: create a one-off chat for each existing workflow run
INSERT INTO "flamecast"."chats" ("id", "user_id", "title", "repo", "source_repo_id", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  wr."user_id",
  COALESCE(LEFT(wr."prompt", 80), 'Untitled'),
  wr."repo",
  wr."source_repo_id",
  wr."created_at",
  wr."created_at"
FROM "flamecast"."workflow_runs" wr
WHERE wr."chat_id" IS NULL;--> statement-breakpoint
-- Link each orphaned workflow run to its newly created chat
UPDATE "flamecast"."workflow_runs" wr
SET "chat_id" = c."id"
FROM "flamecast"."chats" c
WHERE wr."chat_id" IS NULL
  AND c."user_id" = wr."user_id"
  AND c."created_at" = wr."created_at"
  AND c."title" = COALESCE(LEFT(wr."prompt", 80), 'Untitled');