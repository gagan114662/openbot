import { createDatabase } from "../../src/db/client";
import {
  artifactChecksum,
  createWorkflowRuntime,
} from "../../src/software-factory/workflow-runtime";

const databaseUrl = process.env.DATABASE_URL;
const tenantId = process.env.WORKFLOW_TEST_TENANT;
const runId = process.env.WORKFLOW_TEST_RUN;
const mode = process.env.WORKFLOW_TEST_MODE;
if (!databaseUrl || !tenantId || !runId || !mode)
  throw new Error("Session-racer fixture is missing its scope.");

const runtime = createWorkflowRuntime(
  createDatabase(databaseUrl, { max: 1 }),
  tenantId,
);
const sessionId =
  mode === "winner" ? "live-process-session" : "stale-process-session";
const content = `${mode} process result`;
const result = {
  summary: content,
  sessionId,
  reviewerSessionId: `${mode}-process-reviewer`,
  verification: {
    accepted: true as const,
    summary: `${mode} process reviewed`,
    checks: ["cross-process ownership"],
  },
  artifacts: [
    {
      kind: "cross-process-race-proof",
      uri: `workflow://${runId}/${mode}`,
      content,
      checksum: artifactChecksum(content),
      revision: "deadbeef",
      producerSessionId: sessionId,
      exitCode: 0,
    },
  ],
};

if (mode === "winner") {
  await Bun.sleep(150);
  console.log(
    JSON.stringify(await runtime.completeStage(runId, "owned", result)),
  );
} else {
  const completion = await runtime.completeStage(runId, "owned", result);
  const failure = await runtime.failStage(
    runId,
    "owned",
    sessionId,
    "stale process failure",
  );
  const interruption = await runtime.interruptStage(
    runId,
    "owned",
    sessionId,
    "stale process interruption",
  );
  console.log(JSON.stringify({ completion, failure, interruption }));
}
