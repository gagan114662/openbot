export const executionTiers = [
  "chat",
  "assisted",
  "managed",
  "autonomous",
] as const;

export type ExecutionTier = (typeof executionTiers)[number];

export type ModelBenchmark = {
  harness?: "codex" | "claude";
  model: string;
  task: string;
  quality: number;
  successfulOutcomes: number;
  attemptedOutcomes: number;
  totalCostMicros: number;
  enabled: boolean;
};

export type RoutingDecision = {
  harness: "codex" | "claude";
  model: string;
  task: string;
  tier: ExecutionTier;
  expectedQuality: number;
  expectedCostPerOutcomeMicros: number;
  reason: string;
};

const finiteNonNegative = (value: number) =>
  Number.isFinite(value) && value >= 0;

export function observedCostPerOutcome(candidate: ModelBenchmark): number {
  if (
    !finiteNonNegative(candidate.totalCostMicros) ||
    !Number.isSafeInteger(candidate.successfulOutcomes) ||
    candidate.successfulOutcomes < 1
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return candidate.totalCostMicros / candidate.successfulOutcomes;
}

/** Candidates not beaten on both quality and cost by another eligible model. */
export function paretoFrontier(candidates: ModelBenchmark[]) {
  return candidates.filter((candidate) => {
    const cost = observedCostPerOutcome(candidate);
    return !candidates.some((other) => {
      if (
        other.model === candidate.model &&
        (other.harness ?? "codex") === (candidate.harness ?? "codex")
      )
        return false;
      const otherCost = observedCostPerOutcome(other);
      return (
        other.quality >= candidate.quality &&
        otherCost <= cost &&
        (other.quality > candidate.quality || otherCost < cost)
      );
    });
  });
}

export function chooseModel(input: {
  task: string;
  tier: ExecutionTier;
  minimumQuality: number;
  candidates: ModelBenchmark[];
}): RoutingDecision {
  if (!executionTiers.includes(input.tier))
    throw new Error("Unknown execution tier.");
  if (
    !Number.isFinite(input.minimumQuality) ||
    input.minimumQuality < 0 ||
    input.minimumQuality > 1
  )
    throw new Error("Minimum quality must be between zero and one.");
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.enabled &&
      candidate.task === input.task &&
      Number.isFinite(candidate.quality) &&
      candidate.quality >= input.minimumQuality &&
      candidate.attemptedOutcomes >= 1,
  );
  if (eligible.length === 0)
    throw new Error(
      `No benchmarked model clears the quality floor for ${input.task}.`,
    );
  const frontier = paretoFrontier(eligible);
  const selected = [...frontier].sort((left, right) => {
    const cost = observedCostPerOutcome(left) - observedCostPerOutcome(right);
    return (
      cost ||
      right.quality - left.quality ||
      left.model.localeCompare(right.model)
    );
  })[0];
  if (!selected) throw new Error("No Pareto-optimal model is available.");
  return {
    harness: selected.harness ?? "codex",
    model: selected.model,
    task: input.task,
    tier: input.tier,
    expectedQuality: selected.quality,
    expectedCostPerOutcomeMicros: observedCostPerOutcome(selected),
    reason: `Cheapest observed cost per successful outcome on the quality-clearing Pareto frontier (${frontier.length} candidates).`,
  };
}

export function recordOutcome(
  candidate: ModelBenchmark,
  outcome: { success: boolean; costMicros: number },
): ModelBenchmark {
  if (!Number.isSafeInteger(outcome.costMicros) || outcome.costMicros < 0)
    throw new Error("Outcome cost must be non-negative integer micros.");
  const attemptedOutcomes = candidate.attemptedOutcomes + 1;
  const successfulOutcomes =
    candidate.successfulOutcomes + (outcome.success ? 1 : 0);
  return {
    ...candidate,
    attemptedOutcomes,
    successfulOutcomes,
    totalCostMicros: candidate.totalCostMicros + outcome.costMicros,
    quality: successfulOutcomes / attemptedOutcomes,
  };
}
