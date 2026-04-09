CREATE TABLE "flamecast"."message_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text,
	"text" text NOT NULL,
	"runtime" text NOT NULL,
	"agent" text NOT NULL,
	"agent_template_id" text,
	"directory" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_message_queue_pending" ON "flamecast"."message_queue" USING btree ("session_id","status","created_at");
