CREATE TABLE "shadow_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_key" text NOT NULL,
	"primary_model" text NOT NULL,
	"shadow_model" text NOT NULL,
	"primary_output_hash" text NOT NULL,
	"shadow_output_hash" text NOT NULL,
	"agreement_basis_points" integer NOT NULL,
	"shadow_latency_ms" integer NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_evaluations_request_uidx" ON "shadow_evaluations" USING btree ("tenant_id","request_key","shadow_model");--> statement-breakpoint
CREATE INDEX "shadow_evaluations_tenant_created_idx" ON "shadow_evaluations" USING btree ("tenant_id","created_at");