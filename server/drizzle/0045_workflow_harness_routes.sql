ALTER TABLE "factory_managed_jobs" ADD COLUMN "selected_harness" text;--> statement-breakpoint
ALTER TABLE "factory_model_benchmarks" ADD COLUMN "harness" text DEFAULT 'codex' NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_model_benchmarks" DROP CONSTRAINT "factory_model_benchmarks_tenant_id_model_task_pk";--> statement-breakpoint
ALTER TABLE "factory_model_benchmarks" ADD CONSTRAINT "factory_model_benchmarks_tenant_id_harness_model_task_pk" PRIMARY KEY("tenant_id","harness","model","task");--> statement-breakpoint
ALTER TABLE "factory_workflow_stages" ADD COLUMN "selected_model" text;--> statement-breakpoint
ALTER TABLE "factory_workflow_stages" ADD COLUMN "selected_harness" text;
