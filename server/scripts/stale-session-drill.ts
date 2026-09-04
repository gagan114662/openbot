import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { factoryWorkflowEvents } from "../src/db/schema";
import { createSoftwareFactoryStore } from "../src/software-factory/store";
import {
  artifactChecksum,
  createWorkflowRuntime,
} from "../src/software-factory/workflow-runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const tenantId = process.env.STALE_SESSION_DRILL_TENANT ?? "openbot";
const database = createDatabase(databaseUrl, { max: 2 });
const runtime = createWorkflowRuntime(database, tenantId);
const childMode = process.argv[2];
const runId = process.env.STALE_SESSION_DRILL_RUN;

const stageResult = (mode: "winner" | "stale") => {
  const sessionId = `${mode}-process-session`;
  const content = `${mode} process result`;
  return {
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
        revision: "stale-session-drill",
        producerSessionId: sessionId,
        exitCode: 0,
      },
    ],
  };
};

if (childMode === "winner" || childMode === "stale") {
  if (!runId)
    throw new Error("STALE_SESSION_DRILL_RUN is required for a child.");
  const result = stageResult(childMode);
  if (childMode === "winner") {
    await Bun.sleep(200);
    console.log(
      JSON.stringify(await runtime.completeStage(runId, "owned", result)),
    );
  } else {
    const completion = await runtime.completeStage(runId, "owned", result);
    const failure = await runtime.failStage(
      runId,
      "owned",
      result.sessionId,
      "stale process failure",
    );
    const interruption = await runtime.interruptStage(
      runId,
      "owned",
      result.sessionId,
      "stale process interruption",
    );
    console.log(JSON.stringify({ completion, failure, interruption }));
  }
} else {
  const store = createSoftwareFactoryStore(database, tenantId);
  await store.benchmark({
    source: "measured",
    model: "stale-session-drill",
    task: "ci-repair",
    quality: 1,
    successfulOutcomes: 1,
    attemptedOutcomes: 1,
    totalCostMicros: 0,
    enabled: true,
  });
  const queued = await store.queueJob("stale-session-drill", {
    kind: "ci-repair",
    tier: "managed",
    objective: "Prove that a stale worker cannot overwrite its replacement.",
    trigger: `stale-session-drill-${crypto.randomUUID()}`,
    minimumQuality: 0.8,
  });
  const run = await runtime.create({
    jobId: queued.job.id,
    maximumAttempts: 1,
    concurrencyLimit: 1,
    stages: [
      {
        id: "owned",
        objective:
          "Commit exactly one process result and expose all stale refusals.",
        requiredContext: [],
        dependsOn: [],
      },
    ],
  });
  await runtime.claim("stale-session-drill-owner", 5_000);
  await runtime.startStage(run.id, "owned", "winner-process-session");
  const spawn = (mode: "winner" | "stale") =>
    Bun.spawn(["bun", import.meta.path, mode], {
      env: {
        ...process.env,
        STALE_SESSION_DRILL_TENANT: tenantId,
        STALE_SESSION_DRILL_RUN: run.id,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  const winner = spawn("winner");
  const stale = spawn("stale");
  const staleOutput = await new Response(stale.stdout).text();
  const winnerOutput = await new Response(winner.stdout).text();
  const staleError = await new Response(stale.stderr).text();
  const winnerError = await new Response(winner.stderr).text();
  if ((await stale.exited) !== 0 || (await winner.exited) !== 0)
    throw new Error(`Drill child failed: ${staleError}${winnerError}`);
  const events = await database
    .select()
    .from(factoryWorkflowEvents)
    .where(eq(factoryWorkflowEvents.runId, run.id));
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        stale: JSON.parse(staleOutput),
        winner: JSON.parse(winnerOutput),
        refusalEvents: events.filter(
          (event) =>
            (event.detail as { reason?: unknown }).reason === "stale-session",
        ),
      },
      null,
      2,
    ),
  );
}
