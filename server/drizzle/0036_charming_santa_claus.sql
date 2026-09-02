CREATE TABLE "factory_workflow_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage_id" text NOT NULL,
	"kind" text NOT NULL,
	"uri" text NOT NULL,
	"checksum" text NOT NULL,
	"revision" text NOT NULL,
	"command" text,
	"exit_code" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"maximum_attempts" integer NOT NULL,
	"concurrency_limit" integer NOT NULL,
	"steering" jsonb DEFAULT '{"events":[]}'::jsonb NOT NULL,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"abort_requested" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_workflow_stages" (
	"run_id" uuid NOT NULL,
	"stage_id" text NOT NULL,
	"objective" text NOT NULL,
	"required_context" jsonb DEFAULT '{"keys":[]}'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '{"ids":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"session_id" text,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_workflow_stages_run_id_stage_id_pk" PRIMARY KEY("run_id","stage_id")
);
--> statement-breakpoint
ALTER TABLE "factory_workflow_artifacts" ADD CONSTRAINT "factory_workflow_artifacts_run_id_factory_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."factory_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_workflow_runs" ADD CONSTRAINT "factory_workflow_runs_job_id_factory_managed_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."factory_managed_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_workflow_stages" ADD CONSTRAINT "factory_workflow_stages_run_id_factory_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."factory_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "factory_workflow_artifacts_identity_uidx" ON "factory_workflow_artifacts" USING btree ("run_id","stage_id","kind","uri","checksum");--> statement-breakpoint
CREATE INDEX "factory_workflow_artifacts_run_idx" ON "factory_workflow_artifacts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "factory_workflow_runs_job_uidx" ON "factory_workflow_runs" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "factory_workflow_runs_ready_idx" ON "factory_workflow_runs" USING btree ("tenant_id","status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "factory_workflow_stages_status_idx" ON "factory_workflow_stages" USING btree ("run_id","status");