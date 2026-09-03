import { describe, expect, test } from "bun:test";
import {
  chooseModel,
  type observedCostPerOutcome,
  paretoFrontier,
  recordOutcome,
} from "./model-router";

const model = (
  overrides: Partial<Parameters<typeof observedCostPerOutcome>[0]> = {},
) => ({
  model: "worker-small",
  task: "ci-repair",
  quality: 0.9,
  successfulOutcomes: 9,
  attemptedOutcomes: 10,
  totalCostMicros: 900,
  enabled: true,
  ...overrides,
});

describe("benchmark-driven model routing", () => {
  test("chooses the cheapest quality-clearing model on the Pareto frontier", () => {
    const decision = chooseModel({
      task: "ci-repair",
      tier: "managed",
      minimumQuality: 0.8,
      candidates: [
        model({ model: "frontier", quality: 0.97, totalCostMicros: 9_700 }),
        model({ model: "worker-small" }),
        model({ model: "cheap-but-wrong", quality: 0.5, totalCostMicros: 10 }),
      ],
    });
    expect(decision.model).toBe("worker-small");
    expect(decision.harness).toBe("codex");
    expect(decision.expectedCostPerOutcomeMicros).toBe(100);
  });

  test("routes a benchmarked model and harness as one measured configuration", () => {
    const decision = chooseModel({
      task: "ci-repair",
      tier: "managed",
      minimumQuality: 0.8,
      candidates: [
        model({ harness: "codex", model: "gpt", totalCostMicros: 1_800 }),
        model({ harness: "claude", model: "sonnet", totalCostMicros: 900 }),
      ],
    });
    expect(decision).toMatchObject({ harness: "claude", model: "sonnet" });
  });

  test("removes a model dominated on both quality and outcome cost", () => {
    const weak = model({
      model: "weak",
      quality: 0.82,
      totalCostMicros: 1_800,
    });
    const strong = model({
      model: "strong",
      quality: 0.91,
      totalCostMicros: 900,
    });
    expect(paretoFrontier([weak, strong]).map((item) => item.model)).toEqual([
      "strong",
    ]);
  });

  test("feeds verified success and exact integer cost back into the next route", () => {
    const updated = recordOutcome(model(), { success: false, costMicros: 100 });
    expect(updated).toMatchObject({
      attemptedOutcomes: 11,
      successfulOutcomes: 9,
      totalCostMicros: 1_000,
      quality: 9 / 11,
    });
  });

  test("fails closed when no benchmark clears the job's quality floor", () => {
    expect(() =>
      chooseModel({
        task: "ci-repair",
        tier: "autonomous",
        minimumQuality: 0.99,
        candidates: [model()],
      }),
    ).toThrow("No benchmarked model");
  });
});
