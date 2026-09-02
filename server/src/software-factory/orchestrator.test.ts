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
    work: async ({ unit, route, context, priorResults }) => {
      events.push(
        `${unit.id}:${route.model}:${context[0]?.source}:${priorResults.length}`,
      );
      return {
        workUnitId: unit.id,
        summary: "done",
        evidence: [unit.objective],
        costMicros: 10,
      };
    },
    judge: async ({ results }) => ({
      accepted: results.length === 3,
      reason: "all bounded units verified",
    }),
  };
  const result = await executeManagedJob(
    {
      id: "job-1",
      kind: "ci-repair",
      tier: "managed",
      objective: "repair CI",
      maximumAttempts: 2,
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
    judge: async () => ({ accepted: false, reason: "no" }),
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
