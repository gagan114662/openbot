CREATE TABLE "plugin_tool_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"catalogue_key" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_tool_requests" ADD CONSTRAINT "plugin_tool_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_tool_requests" ADD CONSTRAINT "plugin_tool_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_tool_requests_status_created_idx" ON "plugin_tool_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "plugin_tool_requests_agent_idx" ON "plugin_tool_requests" USING btree ("agent_id");
