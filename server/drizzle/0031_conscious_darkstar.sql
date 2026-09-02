CREATE TABLE "production_investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"outcome" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"root_cause" text DEFAULT '' NOT NULL,
	"recent_deploy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fix_status" text DEFAULT 'none' NOT NULL,
	"fix_branch" text,
	"pull_request_url" text,
	"human_approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_issues_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "production_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"intent" text NOT NULL,
	"expression" text NOT NULL,
	"threshold" integer NOT NULL,
	"baseline" integer,
	"firing_count" integer DEFAULT 0 NOT NULL,
	"false_positive_count" integer DEFAULT 0 NOT NULL,
	"tuning_proposal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_monitors_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "production_investigations" ADD CONSTRAINT "production_investigations_issue_id_production_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."production_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_monitor_id_production_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."production_monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_issues_status_created_idx" ON "production_issues" USING btree ("status","created_at");