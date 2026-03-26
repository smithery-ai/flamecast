CREATE TABLE "flamecast"."runtime_instances" (
	"name" text PRIMARY KEY NOT NULL,
	"type_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flamecast"."sessions" ADD COLUMN "runtime" text;