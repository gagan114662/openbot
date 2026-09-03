CREATE TABLE "factory_benchmark_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"benchmark_run_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"harness" text NOT NULL,
	"model" text NOT NULL,
	"check_id" text NOT NULL,
	"passed" boolean NOT NULL,
	"wall_time_ms" integer NOT NULL,
	"repair_attempts" integer NOT NULL,
	"tokens" integer,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_benchmark_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"task" text NOT NULL,
	"revision" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "factory_managed_jobs" ADD COLUMN "routing_source" text;--> statement-breakpoint
ALTER TABLE "factory_managed_jobs" ADD COLUMN "routing_reason" text;--> statement-breakpoint
ALTER TABLE "factory_model_benchmarks" ADD COLUMN "source" text DEFAULT 'seeded' NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_model_benchmarks" ADD COLUMN "benchmark_run_id" uuid;--> statement-breakpoint
ALTER TABLE "factory_model_benchmarks" ADD COLUMN "seed_reason" text;--> statement-breakpoint
UPDATE "factory_model_benchmarks"
SET "source" = 'seeded',
    "seed_reason" = 'Legacy operator-entered row predating executed benchmark runs';--> statement-breakpoint
ALTER TABLE "factory_benchmark_outcomes" ADD CONSTRAINT "factory_benchmark_outcomes_benchmark_run_id_factory_benchmark_runs_id_fk" FOREIGN KEY ("benchmark_run_id") REFERENCES "public"."factory_benchmark_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "factory_benchmark_outcomes_identity_uidx" ON "factory_benchmark_outcomes" USING btree ("benchmark_run_id","harness","model","check_id");--> statement-breakpoint
CREATE INDEX "factory_benchmark_runs_tenant_created_idx" ON "factory_benchmark_runs" USING btree ("tenant_id","created_at");
