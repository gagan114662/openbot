ALTER TABLE "analytics_sessions" ALTER COLUMN "total_tokens" TYPE bigint;
ALTER TABLE "analytics_sessions" ALTER COLUMN "cost_micros" TYPE bigint;
ALTER TABLE "analytics_events" ALTER COLUMN "input_tokens" TYPE bigint;
ALTER TABLE "analytics_events" ALTER COLUMN "output_tokens" TYPE bigint;
ALTER TABLE "analytics_events" ALTER COLUMN "cost_micros" TYPE bigint;
ALTER TABLE "analytics_spans" ALTER COLUMN "input_tokens" TYPE bigint;
ALTER TABLE "analytics_spans" ALTER COLUMN "output_tokens" TYPE bigint;
ALTER TABLE "analytics_spans" ALTER COLUMN "cost_micros" TYPE bigint;
