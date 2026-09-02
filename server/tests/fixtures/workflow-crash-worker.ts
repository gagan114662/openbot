import { createDatabase } from "../../src/db/client";
import { createWorkflowRuntime } from "../../src/software-factory/workflow-runtime";

const databaseUrl = process.env.DATABASE_URL;
const tenantId = process.env.WORKFLOW_TEST_TENANT;
const runId = process.env.WORKFLOW_TEST_RUN;
if (!databaseUrl || !tenantId || !runId)
  throw new Error("Crash-worker fixture is missing its scope.");
const runtime = createWorkflowRuntime(
  createDatabase(databaseUrl, { max: 1 }),
  tenantId,
);
const claimed = await runtime.claim("worker-that-will-die", 100);
if (claimed?.id !== runId)
  throw new Error("Crash worker did not claim the expected run.");
const stage = await runtime.startStage(runId, "crash-stage", "killed-session");
if (!stage) throw new Error("Crash worker did not start its stage.");
console.log("STAGE_STARTED");
await new Promise(() => undefined);
