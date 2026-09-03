CREATE TABLE "reconciled_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"aggregate_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reconciled_webhooks_event_uidx" ON "reconciled_webhook_events" USING btree ("tenant_id","provider","event_id");--> statement-breakpoint
CREATE INDEX "reconciled_webhooks_ready_idx" ON "reconciled_webhook_events" USING btree ("tenant_id","status","available_at");--> statement-breakpoint
CREATE INDEX "reconciled_webhooks_aggregate_idx" ON "reconciled_webhook_events" USING btree ("tenant_id","provider","aggregate_key","sequence");