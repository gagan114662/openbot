CREATE TABLE "agent_tool_assertion_uses" (
  "assertion_id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "agent_tool_assertion_uses_expires_idx" ON "agent_tool_assertion_uses" USING btree ("expires_at");
