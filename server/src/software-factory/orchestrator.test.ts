import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { executeManagedJob, type FactoryExecutor } from "./orchestrator";

test("a judging orchestrator grounds and runs independent cheaper workers before dependent work", async () => {
  const events: string[] = [];
  const executor: FactoryExecutor = {
    plan: async () => [
      {
        id: "tests",
        objective: "inspect CI",
        requiredContext: ["ci:failure"],
        dependsOn: [],
      },
      {
        id: "code",
        objective: "inspect code",
        requiredContext: ["repo:owner"],
        dependsOn: [],
      },
      {
        id: "fix",
        objective: "repair",
        requiredContext: ["runbook:ci"],
        dependsOn: ["tests", "code"],
      },
    ],
    route: async (unit) => ({
      harness: "codex",
      model: unit.id === "fix" ? "frontier" : "worker-small",
      task: "ci-repair",
      tier: "managed",
      expectedQuality: 0.9,
      expectedCostPerOutcomeMicros: 10,
      reason: "benchmark",
    }),
    ground: async (keys) =>
      keys.map((key) => ({
        key,
        value: `value:${key}`,
        source: "context-graph",
      })),
    work: async ({ unit, route, context, priorResults, attempt }) => {
      events.push(
        `${unit.id}:${route.model}:${context[0]?.source}:${priorResults.length}`,
      );
      return {
        workUnitId: unit.id,
        producerSessionId: `worker-${attempt}-${unit.id}`,
        summary: "done",
        evidence: [
          {
            uri: `artifact://${unit.id}`,
            checksum: createHash("sha256").update(unit.objective).digest("hex"),
            revision: "abc123",
            producerSessionId: `worker-${attempt}-${unit.id}`,
            command: "bun test",
            exitCode: 0,
          },
        ],
        costMicros: 10,
      };
    },
    judge: async ({ results }) => ({
      accepted: results.length === 3,
      reason: "all bounded units verified",
      reviewerSessionId: "fresh-reviewer",
    }),
  };
  const result = await executeManagedJob(
    {
      id: "job-1",
      kind: "ci-repair",
      tier: "managed",
      objective: "repair CI",
      maximumAttempts: 2,
      concurrencyLimit: 2,
    },
    executor,
  );
  expect(result).toMatchObject({ accepted: true, totalCostMicros: 30 });
  expect(events.slice(0, 2).sort()).toEqual([
    "code:worker-small:context-graph:0",
    "tests:worker-small:context-graph:0",
  ]);
  expect(events[2]).toBe("fix:frontier:context-graph:2");
});

test("cyclic plans fail before any worker can wander", async () => {
  const executor = {
    plan: async () => [
      { id: "a", objective: "a", requiredContext: [], dependsOn: ["b"] },
      { id: "b", objective: "b", requiredContext: [], dependsOn: ["a"] },
    ],
    route: async () => {
      throw new Error("must not route");
    },
    ground: async () => [],
    work: async () => {
      throw new Error("must not work");
    },
    judge: async () => ({
      accepted: false,
      reason: "no",
      reviewerSessionId: "reviewer",
    }),
  } satisfies FactoryExecutor;
  await expect(
    executeManagedJob(
      {
        id: "job-cycle",
        kind: "bug-triage",
        tier: "managed",
        objective: "triage",
        maximumAttempts: 1,
      },
      executor,
    ),
  ).rejects.toThrow("dependency cycle");
});

test("a rejected verdict drives a bounded repair with fresh workers and reviewer", async () => {
  const attempts: Array<{ attempt: number; repairReason: string | null }> = [];
  const executor: FactoryExecutor = {
    plan: async () => [
      { id: "repair", objective: "repair", requiredContext: [], dependsOn: [] },
    ],
    route: async () => ({
      harness: "codex",
      model: "worker-small",
      task: "ci-repair",
      tier: "managed",
      expectedQuality: 0.9,
      expectedCostPerOutcomeMicros: 10,
      reason: "benchmark",
    }),
    ground: async () => [],
    work: async ({ unit, attempt, repairReason }) => {
      attempts.push({ attempt, repairReason });
      const producerSessionId = `worker-${attempt}`;
      return {
        workUnitId: unit.id,
        producerSessionId,
        summary: `candidate ${attempt}`,
        evidence: [
          {
            uri: `artifact://${attempt}`,
            checksum: createHash("sha256")
              .update(String(attempt))
              .digest("hex"),
            revision: `revision-${attempt}`,
            producerSessionId,
            command: "bun test",
            exitCode: 0,
          },
        ],
        costMicros: 10,
      };
    },
    judge: async ({ attempt }) => ({
      accepted: attempt === 2,
      reason: attempt === 1 ? "missing regression proof" : "verified",
      reviewerSessionId: `reviewer-${attempt}`,
    }),
  };
  const result = await executeManagedJob(
    {
      id: "job-repair",
      kind: "ci-repair",
      tier: "managed",
      objective: "repair CI",
      maximumAttempts: 2,
    },
    executor,
  );
  expect(result).toMatchObject({
    accepted: true,
    attempt: 2,
    totalCostMicros: 20,
  });
  expect(attempts).toEqual([
    { attempt: 1, repairReason: null },
    { attempt: 2, repairReason: "missing regression proof" },
  ]);
});
