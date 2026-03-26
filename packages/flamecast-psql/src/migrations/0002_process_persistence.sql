ALTER TABLE "flamecast"."sessions" ADD COLUMN "host_url" text;--> statement-breakpoint
ALTER TABLE "flamecast"."sessions" ADD COLUMN "websocket_url" text;--> statement-breakpoint
ALTER TABLE "flamecast"."sessions" ADD COLUMN "runtime_name" text;--> statement-breakpoint
ALTER TABLE "flamecast"."sessions" ADD COLUMN "runtime_meta" jsonb;