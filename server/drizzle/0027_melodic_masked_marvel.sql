CREATE TABLE "evolution_checkpoints" (
	"chain_id" text PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"evidence_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
