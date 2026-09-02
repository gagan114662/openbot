CREATE TABLE "context_compaction_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"checksum" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "context_compaction_artifact_run_checksum_uidx" ON "context_compaction_artifacts" USING btree ("tenant_id","run_id","checksum");--> statement-breakpoint
CREATE INDEX "context_compaction_artifact_thread_idx" ON "context_compaction_artifacts" USING btree ("tenant_id","thread_id","created_at");