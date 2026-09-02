CREATE TABLE "verified_value_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"evidence_checksum" text NOT NULL,
	"baseline_started_at" timestamp with time zone NOT NULL,
	"baseline_completed_at" timestamp with time zone NOT NULL,
	"actual_started_at" timestamp with time zone NOT NULL,
	"actual_completed_at" timestamp with time zone NOT NULL,
	"human_minutes_saved" integer NOT NULL,
	"hourly_labor_micros" bigint NOT NULL,
	"labor_value_micros" bigint NOT NULL,
	"revenue_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verified_value_outcomes" ADD CONSTRAINT "verified_value_outcomes_workflow_run_id_factory_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."factory_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verified_value_source_event_uidx" ON "verified_value_outcomes" USING btree ("tenant_id","source","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_value_workflow_uidx" ON "verified_value_outcomes" USING btree ("tenant_id","workflow_run_id");--> statement-breakpoint
CREATE INDEX "verified_value_created_idx" ON "verified_value_outcomes" USING btree ("tenant_id","created_at");