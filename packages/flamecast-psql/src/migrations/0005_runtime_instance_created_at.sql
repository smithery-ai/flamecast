ALTER TABLE "flamecast"."runtime_instances"
ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
