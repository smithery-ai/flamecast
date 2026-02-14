ALTER TABLE "flamecast"."workflow_runs" ADD COLUMN "parent_workflow_run_id" bigint;
CREATE INDEX "flamecast_workflow_runs_parent_idx" ON "flamecast"."workflow_runs" USING btree ("parent_workflow_run_id");
