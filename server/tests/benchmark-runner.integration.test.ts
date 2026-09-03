import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  factoryBenchmarkOutcomes,
  factoryBenchmarkRuns,
  factoryManagedJobs,
  factoryModelBenchmarks,
  factoryWorkflowArtifacts,
  factoryWorkflowRuns,
  factoryWorkflowStages,
} from "../src/db/schema";
import { factoryBenchmarkCatalog } from "../src/software-factory/benchmark-catalog";
import { createFactoryBenchmarkRunner } from "../src/software-factory/benchmark-runner";
import { createSoftwareFactoryStore } from "../src/software-factory/store";
import {
  artifactChecksum,
  createWorkflowRuntime,
} from "../src/software-factory/workflow-runtime";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tenantId = `benchmark-test-${crypto.randomUUID()}`;
const store = createSoftwareFactoryStore(database, tenantId);
const runtime = createWorkflowRuntime(database, tenantId);
const runner = createFactoryBenchmarkRunner({
  database,
  tenantId,
  store,
  runtime,
  revision: "fixed-benchmark-revision",
});
let benchmarkRunId = "";
let workflowRunIds: string[] = [];

afterAll(async () => {
  if (benchmarkRunId)
    await database
      .delete(factoryBenchmarkOutcomes)
      .where(eq(factoryBenchmarkOutcomes.benchmarkRunId, benchmarkRunId));
  if (workflowRunIds.length) {
    await database
      .delete(factoryWorkflowArtifacts)
      .where(inArray(factoryWorkflowArtifacts.runId, workflowRunIds));
    await database
      .delete(factoryWorkflowStages)
      .where(inArray(factoryWorkflowStages.runId, workflowRunIds));
    await database
      .delete(factoryWorkflowRuns)
      .where(inArray(factoryWorkflowRuns.id, workflowRunIds));
  }
  await database
    .delete(factoryManagedJobs)
    .where(eq(factoryManagedJobs.tenantId, tenantId));
  await database
    .delete(factoryModelBenchmarks)
    .where(eq(factoryModelBenchmarks.tenantId, tenantId));
  await database
    .delete(factoryBenchmarkRuns)
    .where(eq(factoryBenchmarkRuns.tenantId, tenantId));
});

test("persists two supplied check-outcome bundles and derives positive-cost quality", async () => {
  const started = await runner.start("benchmark-admin", "ci-repair-v1");
  benchmarkRunId = started.run.id;
  workflowRunIds = started.workflows.map((workflow) => workflow.workflowRunId);
  expect(started.workflows).toHaveLength(2);

  for (const [pairIndex, workflow] of started.workflows.entries()) {
    const claimed = await runtime.claim(`benchmark-worker-${pairIndex}`);
    expect(claimed?.id).toBe(workflow.workflowRunId);
    const [stage] = await runtime.readyStages(workflow.workflowRunId);
    expect(stage?.stageId).toBe("benchmark");
    const sessionId = `benchmark-session-${pairIndex}`;
    await runtime.startStage(workflow.workflowRunId, "benchmark", sessionId);
    const checkArtifacts = factoryBenchmarkCatalog["ci-repair-v1"].checks.map(
      (check, checkIndex) => {
        const exitCode = pairIndex === 1 && checkIndex === 0 ? 1 : 0;
        const content = JSON.stringify({
          kind: "runtime-check",
          id: check.id,
          exitCode,
        });
        return {
          kind: "runtime-check",
          uri: `benchmark://${pairIndex}/${check.id}`,
          content,
          checksum: artifactChecksum(content),
          revision: "fixed-benchmark-revision",
          producerSessionId: sessionId,
          command: check.command.join(" "),
          exitCode,
          metadata: {
            checkId: check.id,
            durationMs: 10 + checkIndex,
            evidenceSource: "runtime-executed",
          },
        };
      },
    );
    const stageResultContent = JSON.stringify({ summary: "candidate output" });
    const artifacts = [
      {
        kind: "codex-stage-result",
        uri: `benchmark://${pairIndex}/stage-result`,
        content: stageResultContent,
        checksum: artifactChecksum(stageResultContent),
        revision: "fixed-benchmark-revision",
        producerSessionId: sessionId,
        exitCode: 0,
        metadata: {
          usage: {
            totalTokens: 1_500 + pairIndex,
            costMicros: 4_200 + pairIndex,
            costBasis: "provider-reported",
          },
        },
      },
      ...checkArtifacts,
    ];
    await runtime.completeStage(workflow.workflowRunId, "benchmark", {
      summary: "the model claims success",
      sessionId,
      reviewerSessionId: `benchmark-reviewer-${pairIndex}`,
      verification: {
        accepted: true,
        summary: "reviewer accepted the narrative",
        checks: ["narrative-only"],
      },
      artifacts,
    });
    await runner.recordWorkflow(
      (await runtime.snapshot(workflow.workflowRunId))!,
    );
    expect((await runtime.snapshot(workflow.workflowRunId))?.run.status).toBe(
      "succeeded",
    );
    expect((await runtime.snapshot(workflow.workflowRunId))?.run).toMatchObject(
      { approvedBy: null, completedBy: "benchmark-runner" },
    );
  }

  const dashboard = await store.dashboard();
  const measured = dashboard.benchmarks.filter(
    (benchmark) => benchmark.benchmarkRunId === benchmarkRunId,
  );
  expect(measured).toHaveLength(2);
  expect(measured.map((benchmark) => benchmark.source)).toEqual([
    "measured",
    "measured",
  ]);
  expect(measured.map((benchmark) => benchmark.attemptedOutcomes)).toEqual([
    6, 6,
  ]);
  expect(
    measured.find((benchmark) => benchmark.harness === "claude")?.quality,
  ).toBe(0);
  expect(measured.every((benchmark) => benchmark.totalCostMicros > 0)).toBe(
    true,
  );
  expect((await runner.dashboard()).outcomes).toHaveLength(12);
});
