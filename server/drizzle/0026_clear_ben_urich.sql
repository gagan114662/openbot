CREATE TYPE "public"."analytics_evaluator_kind" AS ENUM('code', 'llm_judge');--> statement-breakpoint
CREATE TYPE "public"."analytics_lifecycle" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."analytics_permission" AS ENUM('view', 'manage_evals', 'activate_evals');--> statement-breakpoint
CREATE TYPE "public"."analytics_privacy_mode" AS ENUM('full', 'metadata_only', 'customer_enriched');--> statement-breakpoint
CREATE TYPE "public"."analytics_run_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."analytics_score_type" AS ENUM('binary', 'categorical', 'numeric');--> statement-breakpoint
CREATE TYPE "public"."analytics_session_status" AS ENUM('running', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."analytics_span_kind" AS ENUM('agent', 'llm', 'tool', 'retrieval', 'product');--> statement-breakpoint
CREATE TABLE "analytics_dataset_sessions" (
	"dataset_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_dataset_sessions_dataset_id_session_id_pk" PRIMARY KEY("dataset_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"golden" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_eval_results" (
	"run_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"numeric_score" integer,
	"category" text,
	"passed" boolean,
	"explanation" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_eval_results_run_id_session_id_pk" PRIMARY KEY("run_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluator_id" uuid NOT NULL,
	"evaluator_version" integer NOT NULL,
	"dataset_id" uuid,
	"calibration" boolean DEFAULT false NOT NULL,
	"status" "analytics_run_status" DEFAULT 'queued' NOT NULL,
	"baseline_score" integer,
	"aggregate_score" integer,
	"regression" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_evaluator_versions" (
	"evaluator_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_evaluator_versions_evaluator_id_version_pk" PRIMARY KEY("evaluator_id","version")
);
--> statement-breakpoint
CREATE TABLE "analytics_evaluators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" "analytics_evaluator_kind" NOT NULL,
	"score_type" "analytics_score_type" NOT NULL,
	"lifecycle" "analytics_lifecycle" DEFAULT 'draft' NOT NULL,
	"active_version" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"name" text NOT NULL,
	"content" text,
	"user_id" text,
	"agent_id" text,
	"model" text,
	"prompt_version" text,
	"replay_id" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"success" boolean,
	"error_type" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"event_id" uuid,
	"user_id" text,
	"rating" integer,
	"negative" boolean DEFAULT false NOT NULL,
	"category" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_permissions" (
	"user_id" text NOT NULL,
	"permission" "analytics_permission" NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_permissions_user_id_permission_pk" PRIMARY KEY("user_id","permission")
);
--> statement-breakpoint
CREATE TABLE "analytics_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"dataset_id" uuid,
	"reviewer_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"label" text,
	"error_category" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_session_topics" (
	"session_id" text NOT NULL,
	"topic_id" uuid NOT NULL,
	"confidence" integer NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "analytics_session_topics_session_id_topic_id_pk" PRIMARY KEY("session_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "analytics_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"agent_id" text,
	"source" text NOT NULL,
	"privacy_mode" "analytics_privacy_mode" DEFAULT 'metadata_only' NOT NULL,
	"status" "analytics_session_status" DEFAULT 'running' NOT NULL,
	"intent" text,
	"summary" text,
	"replay_id" text,
	"replay_url" text,
	"model" text,
	"prompt_version" text,
	"experiment_key" text,
	"experiment_variant" text,
	"task_completed" boolean,
	"technical_failure" boolean DEFAULT false NOT NULL,
	"tool_failure" boolean DEFAULT false NOT NULL,
	"negative_feedback" boolean DEFAULT false NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"event_id" uuid,
	"parent_span_id" text,
	"trace_id" text NOT NULL,
	"kind" "analytics_span_kind" NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"input" text,
	"output" text,
	"model" text,
	"tool_name" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_topics_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "analytics_dataset_sessions" ADD CONSTRAINT "analytics_dataset_sessions_dataset_id_analytics_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."analytics_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_dataset_sessions" ADD CONSTRAINT "analytics_dataset_sessions_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_eval_results" ADD CONSTRAINT "analytics_eval_results_run_id_analytics_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analytics_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_eval_results" ADD CONSTRAINT "analytics_eval_results_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_eval_runs" ADD CONSTRAINT "analytics_eval_runs_evaluator_id_analytics_evaluators_id_fk" FOREIGN KEY ("evaluator_id") REFERENCES "public"."analytics_evaluators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_eval_runs" ADD CONSTRAINT "analytics_eval_runs_dataset_id_analytics_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."analytics_datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_evaluator_versions" ADD CONSTRAINT "analytics_evaluator_versions_evaluator_id_analytics_evaluators_id_fk" FOREIGN KEY ("evaluator_id") REFERENCES "public"."analytics_evaluators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_feedback" ADD CONSTRAINT "analytics_feedback_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_feedback" ADD CONSTRAINT "analytics_feedback_event_id_analytics_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."analytics_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_reviews" ADD CONSTRAINT "analytics_reviews_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_reviews" ADD CONSTRAINT "analytics_reviews_dataset_id_analytics_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."analytics_datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_session_topics" ADD CONSTRAINT "analytics_session_topics_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_session_topics" ADD CONSTRAINT "analytics_session_topics_topic_id_analytics_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."analytics_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_spans" ADD CONSTRAINT "analytics_spans_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."analytics_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_spans" ADD CONSTRAINT "analytics_spans_event_id_analytics_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."analytics_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_source_idempotency_idx" ON "analytics_events" USING btree ("source","idempotency_key");--> statement-breakpoint
CREATE INDEX "analytics_events_session_occurred_idx" ON "analytics_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_type_occurred_idx" ON "analytics_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_sessions_started_idx" ON "analytics_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "analytics_sessions_agent_started_idx" ON "analytics_sessions" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "analytics_sessions_user_started_idx" ON "analytics_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "analytics_sessions_status_started_idx" ON "analytics_sessions" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "analytics_spans_session_started_idx" ON "analytics_spans" USING btree ("session_id","started_at");