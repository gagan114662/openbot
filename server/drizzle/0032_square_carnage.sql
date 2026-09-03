CREATE TABLE "factory_context_edges" (
	"tenant_id" text NOT NULL,
	"from_key" text NOT NULL,
	"to_key" text NOT NULL,
	"relation" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_context_edges_tenant_id_from_key_to_key_relation_pk" PRIMARY KEY("tenant_id","from_key","to_key","relation")
);
--> statement-breakpoint
CREATE TABLE "factory_context_nodes" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"value" text NOT NULL,
	"source_system" text NOT NULL,
	"source_url" text,
	"checksum" text NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_context_nodes_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE INDEX "factory_context_edges_from_idx" ON "factory_context_edges" USING btree ("tenant_id","from_key");--> statement-breakpoint
CREATE INDEX "factory_context_edges_to_idx" ON "factory_context_edges" USING btree ("tenant_id","to_key");--> statement-breakpoint
CREATE INDEX "factory_context_nodes_tenant_kind_idx" ON "factory_context_nodes" USING btree ("tenant_id","kind");