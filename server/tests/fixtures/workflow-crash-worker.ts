import { createDatabase } from "../../src/db/client";
import { processOwner } from "../../src/process-owner";
import { createWorkflowRuntime } from "../../src/software-factory/workflow-runtime";

const databaseUrl = process.env.DATABASE_URL;
const tenantId = process.env.WORKFLOW_TEST_TENANT;
const runId = process.env.WORKFLOW_TEST_RUN;
const mode = process.env.WORKFLOW_TEST_MODE ?? "crash";
if (!databaseUrl || !tenantId || !runId)
  throw new Error("Crash-worker fixture is missing its scope.");
const workerId = processOwner("software-factory");
const runtime = createWorkflowRuntime(
  createDatabase(databaseUrl, { max: 1 }),
  tenantId,
);
const claimed = await runtime.claim(workerId, mode === "crash" ? 100 : 1_000);
if (claimed?.id !== runId)
  throw new Error("Crash worker did not claim the expected run.");
const sessionId = `${mode}-session`;
const stage = await runtime.startStage(runId, "crash-stage", sessionId);
if (!stage) throw new Error("Crash worker did not start its stage.");
if (mode === "crash") {
  console.log(JSON.stringify({ event: "STAGE_STARTED", workerId }));
  await new Promise(() => undefined);
} else {
  const content = "completed by the restarted same-host worker";
  await runtime.completeStage(runId, "crash-stage", {
    summary: content,
    sessionId,
    reviewerSessionId: "restart-reviewer",
    verification: {
      accepted: true,
      summary: "same-host restart verified",
      checks: ["durable recovery"],
    },
    artifacts: [
      {
        kind: "same-host-restart-proof",
        uri: `workflow://${runId}/same-host-restart`,
        content,
        checksum: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        revision: "deadbeef",
        producerSessionId: sessionId,
      },
    ],
  });
  console.log(JSON.stringify({ event: "STAGE_COMPLETED", workerId }));
}
