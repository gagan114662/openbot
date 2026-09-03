import { afterAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import {
  analyticsDatasets,
  analyticsEvalResults,
  analyticsEvalRuns,
  analyticsEvaluators,
  analyticsSessions,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createAnalyticsStore(database);
const marker = crypto.randomUUID();
const sessionIds = Array.from(
  { length: 6 },
  (_, index) => `eval-bound-${marker}-${index}`,
);
let evaluatorId = "";
let datasetId = "";

afterAll(async () => {
  if (evaluatorId)
    await database
      .delete(analyticsEvaluators)
      .where(eq(analyticsEvaluators.id, evaluatorId));
  if (datasetId)
    await database
      .delete(analyticsDatasets)
      .where(eq(analyticsDatasets.id, datasetId));
  await database
    .delete(analyticsSessions)
    .where(inArray(analyticsSessions.id, sessionIds));
});

test("LLM evaluation is bounded, records bad JSON, and marks uncaught failures", async () => {
  for (const id of sessionIds) {
    await store.ingest("eval-owner", {
      session: { id, source: "bound-proof", status: "completed" },
    });
  }
  const evaluator = await store.createEvaluator("eval-owner", {
    name: `Bounded judge ${marker}`,
    kind: "llm_judge",
    scoreType: "numeric",
    definition: { threshold: 70 },
  });
  evaluatorId = evaluator.id;
  const dataset = await store.createDataset("eval-owner", {
    name: `Bounded dataset ${marker}`,
    golden: false,
    sessionIds,
  });
  datasetId = dataset.id;
  let inflight = 0;
  let maximum = 0;
  let calls = 0;
  process.env.EVALUATOR_CONCURRENCY = "2";
  store.setLlmJudge(async () => {
    const call = ++calls;
    inflight += 1;
    maximum = Math.max(maximum, inflight);
    await Bun.sleep(10);
    inflight -= 1;
    return call === 1
      ? "not json"
      : JSON.stringify({ score: 90, explanation: "ok" });
  });
  const completed = await store.runEvaluator(
    "eval-owner",
    evaluator.id,
    dataset.id,
  );
  expect(maximum).toBe(2);
  const errors = await database
    .select()
    .from(analyticsEvalResults)
    .where(
      and(
        eq(analyticsEvalResults.runId, completed.runId),
        eq(analyticsEvalResults.category, "judge_error"),
      ),
    );
  expect(errors).toHaveLength(1);

  const [failedRun] = await database
    .insert(analyticsEvalRuns)
    .values({
      evaluatorId: evaluator.id,
      evaluatorVersion: 1,
      datasetId: dataset.id,
      status: "running",
      createdBy: "eval-owner",
    })
    .returning();
  await database.insert(analyticsEvalResults).values({
    runId: failedRun!.id,
    sessionId: sessionIds[0]!,
    numericScore: 1,
  });
  await expect(
    store.runEvaluator(
      "eval-owner",
      evaluator.id,
      dataset.id,
      false,
      failedRun!.id,
    ),
  ).rejects.toThrow();
  const [failed] = await database
    .select()
    .from(analyticsEvalRuns)
    .where(eq(analyticsEvalRuns.id, failedRun!.id));
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed?.failureReason).toBeTruthy();
  delete process.env.EVALUATOR_CONCURRENCY;
});
