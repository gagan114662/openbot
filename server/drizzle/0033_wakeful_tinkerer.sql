CREATE TABLE "factory_managed_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text NOT NULL,
	"objective" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"selected_model" text,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_model_benchmarks" (
	"tenant_id" text NOT NULL,
	"model" text NOT NULL,
	"task" text NOT NULL,
	"quality_basis_points" integer NOT NULL,
	"successful_outcomes" integer DEFAULT 0 NOT NULL,
	"attempted_outcomes" integer DEFAULT 0 NOT NULL,
	"total_cost_micros" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_model_benchmarks_tenant_id_model_task_pk" PRIMARY KEY("tenant_id","model","task")
);
--> statement-breakpoint
CREATE INDEX "factory_managed_jobs_tenant_created_idx" ON "factory_managed_jobs" USING btree ("tenant_id","created_at");