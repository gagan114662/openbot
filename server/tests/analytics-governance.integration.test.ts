import { afterAll, describe, expect, test } from "bun:test";
import { eq, ilike, inArray } from "drizzle-orm";
import { scoreEpisode } from "../../shared/verifiable-reward";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import {
  analyticsDatasets,
  analyticsEvaluators,
  analyticsSessions,
  analyticsTopics,
} from "../src/db/schema";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  // This proof is sequential. One connection also prevents Bun's prepared-
  // statement cache from racing itself when the full suite runs many DB files.
  { max: 1 },
);
const store = createAnalyticsStore(database);
const marker = crypto.randomUUID();
const sessionId = `governance-${marker}`;
const sessionIds = [sessionId];
const datasetIds: string[] = [];
const evaluatorIds: string[] = [];

afterAll(async () => {
  if (evaluatorIds.length > 0)
    await database
      .delete(analyticsEvaluators)
      .where(inArray(analyticsEvaluators.id, evaluatorIds));
  if (datasetIds.length > 0)
    await database
      .delete(analyticsDatasets)
      .where(inArray(analyticsDatasets.id, datasetIds));
  await database
    .delete(analyticsSessions)
    .where(inArray(analyticsSessions.id, sessionIds));
  await database
    .delete(analyticsTopics)
    .where(eq(analyticsTopics.name, `Payments ${marker}`));
  await database
    .delete(analyticsTopics)
    .where(ilike(analyticsTopics.name, `%${marker.slice(0, 8)}%`));
});

describe("analytics governance operations", () => {
  test("claims each due scheduled evaluator once across repeated sweeps", async () => {
    const evaluator = await store.createEvaluator("governance-owner", {
      name: `Scheduled completion ${marker}`,
      kind: "code",
      scoreType: "numeric",
      definition: { signal: "task_completion", threshold: 70 },
    });
    evaluatorIds.push(evaluator.id);
    const first = await store.runScheduledEvaluators("scheduler-proof");
    const second = await store.runScheduledEvaluators("scheduler-proof");
    expect(first).toContain(evaluator.id);
    expect(second).not.toContain(evaluator.id);
  });

  test("runs built-in signals over a reusable dataset and records review/topic state", async () => {
    await store.ingest("governance-owner", {
      session: {
        id: sessionId,
        source: "governance-proof",
        status: "completed",
        taskCompleted: true,
      },
    });
    const governance = await store.ensureBuiltInEvaluators("governance-owner");
    const evaluator = governance.evaluators.find(
      (item) => item.name === "Task Completion",
    );
    expect(evaluator?.activeVersion).toBe(1);
    const dataset = await store.createDataset("governance-owner", {
      name: `Golden ${marker}`,
      golden: true,
      sessionIds: [sessionId],
    });
    datasetIds.push(dataset.id);
    const run = await store.runEvaluator(
      "governance-owner",
      evaluator?.id ?? "",
      dataset.id,
    );
    expect(run.sessions).toBe(1);
    await store.reviewSession("governance-owner", sessionId, {
      status: "completed",
      label: "correct",
      note: "Reviewed in the trace explorer.",
    });
    await store.classifyTopic(sessionId, {
      name: `Payments ${marker}`,
      confidence: 95,
    });
    await store.recordBusinessOutcome("governance-owner", sessionId, {
      name: `Qualified conversion ${marker}`,
      success: true,
      revenueMicros: 12_500_000,
    });
    const detail = await store.detail(sessionId);
    expect(detail?.reviews[0]).toMatchObject({
      label: "correct",
      note: "Reviewed in the trace explorer.",
    });
    expect(detail?.topics).toContainEqual(
      expect.objectContaining({
        name: `Payments ${marker}`,
        source: "human",
      }),
    );
    const updated = await store.governance();
    expect(
      updated.runs.some(
        (item) => item.id === run.runId && item.aggregateScore === 100,
      ),
    ).toBe(true);
    expect(updated.reviews.some((item) => item.sessionId === sessionId)).toBe(
      true,
    );
    expect(updated.outcomes).toContainEqual(
      expect.objectContaining({
        name: `Qualified conversion ${marker}`,
        conversions: 1,
        revenueMicros: 12_500_000,
      }),
    );
  });

  test("meters headless runtime tools once even when a browser observes the same call", async () => {
    const episode = {
      id: sessionId,
      taskId: "headless-routine",
      taskVersion: "1",
      agentVersion: "runtime-v1",
      model: "gpt-test",
      initialStateHash: "before",
      finalStateHash: "after",
      verifierResults: [
        {
          id: "run-lifecycle",
          version: "1",
          passed: true,
          score: 1,
          critical: true,
          evidence: {},
        },
      ],
      reward: {
        taskCorrectness: 1,
        policyCompliance: 1,
        unsupportedClaims: 0,
        unnecessaryToolCalls: 0,
        humanInterventions: 0,
        costUsd: 0,
        latencyMs: 1,
      },
      terminatedBecause: "success" as const,
    };
    await store.recordRuntimeEpisode({
      actorUserId: "governance-owner",
      agentId: "headless-bot",
      episode,
      scored: scoreEpisode(episode),
      toolCalls: [{ id: "shared-call", name: "search_documents" }],
      usage: {
        model: "gpt-test",
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    });
    await store.ingest("governance-owner", {
      session: { id: sessionId, source: "openbot-channel" },
      events: [
        {
          idempotencyKey: `${sessionId}:browser-copy`,
          eventType: "agent.tool.observed",
          name: "search_documents",
          properties: { toolCallId: "shared-call" },
        },
      ],
    });
    const governance = await store.governance();
    expect(governance.toolUsage).toContainEqual(
      expect.objectContaining({
        agentId: "headless-bot",
        tool: "search_documents",
        calls: 1,
      }),
    );
  });

  test("clusters observed behavior without overwriting a human topic", async () => {
    const short = marker.slice(0, 8);
    const examples = [
      [`cluster-pay-${marker}`, `invoice ${short} settlement`, "charge_card"],
      [
        `cluster-bill-${marker}`,
        `billing ${short} reconciliation`,
        "charge_card",
      ],
      [`cluster-code-${marker}`, `repository ${short} build`, "run_tests"],
      [
        `cluster-deploy-${marker}`,
        `deployment ${short} verification`,
        "run_tests",
      ],
    ] as const;
    sessionIds.push(...examples.map(([id]) => id));
    for (const [index, [id, intent, tool]] of examples.entries()) {
      await store.ingest("governance-owner", {
        session: {
          id,
          source: "behavior-proof",
          status: "completed",
          intent,
          taskCompleted: index > 0,
          properties: { threadId: `journey-${marker}` },
        },
        events: [
          {
            idempotencyKey: `${id}:tool`,
            eventType: "agent.tool.observed",
            name: tool,
          },
        ],
      });
    }
    const result = await store.clusterTopics();
    expect(result.clusters).toBeGreaterThanOrEqual(2);
    const governance = await store.governance();
    expect(
      governance.topicScorecards.some((topic) =>
        topic.name.startsWith("Behavior ·"),
      ),
    ).toBe(true);
    expect(
      governance.topicScorecards.some(
        (topic) => topic.name === `Payments ${marker}`,
      ),
    ).toBe(true);
    expect(governance.journeys).toContainEqual(
      expect.objectContaining({
        threadId: `journey-${marker}`,
        turns: 4,
        firstOutcome: false,
        lastOutcome: true,
        improved: true,
      }),
    );
  });
});
