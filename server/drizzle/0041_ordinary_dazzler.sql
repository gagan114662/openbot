CREATE TABLE "factory_workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage_id" text,
	"entity" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "factory_workflow_events" ADD CONSTRAINT "factory_workflow_events_run_id_factory_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."factory_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factory_workflow_events_run_created_idx" ON "factory_workflow_events" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE FUNCTION record_factory_workflow_run_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO factory_workflow_events
      (run_id, entity, from_status, to_status, detail)
    VALUES
      (NEW.id, 'run', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
       jsonb_build_object(
         'leaseOwner', NEW.lease_owner,
         'pauseRequested', NEW.pause_requested,
         'abortRequested', NEW.abort_requested,
         'approvedBy', NEW.approved_by
       ));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER factory_workflow_run_transition
AFTER INSERT OR UPDATE OF status ON factory_workflow_runs
FOR EACH ROW EXECUTE FUNCTION record_factory_workflow_run_transition();
--> statement-breakpoint
CREATE FUNCTION record_factory_workflow_stage_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO factory_workflow_events
      (run_id, stage_id, entity, from_status, to_status, detail)
    VALUES
      (NEW.run_id, NEW.stage_id, 'stage', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
       NEW.status, jsonb_build_object(
         'attempts', NEW.attempts,
         'sessionId', NEW.session_id,
         'reviewerSessionId', NEW.reviewer_session_id,
         'lastError', NEW.last_error
       ));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER factory_workflow_stage_transition
AFTER INSERT OR UPDATE OF status ON factory_workflow_stages
FOR EACH ROW EXECUTE FUNCTION record_factory_workflow_stage_transition();
