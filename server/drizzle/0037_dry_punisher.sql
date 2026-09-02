ALTER TABLE "factory_workflow_stages" ADD COLUMN "reviewer_session_id" text;--> statement-breakpoint
ALTER TABLE "factory_workflow_stages" ADD COLUMN "verification" jsonb DEFAULT '{}'::jsonb NOT NULL;