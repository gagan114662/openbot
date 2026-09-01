export type VerifierResult = {
  id: string;
  version: string;
  passed: boolean;
  score: number;
  evidence: Record<string, unknown>;
  critical?: boolean;
};

export type RewardVector = {
  taskCorrectness: number;
  policyCompliance: number;
  unsupportedClaims: number;
  unnecessaryToolCalls: number;
  humanInterventions: number;
  costUsd: number;
  latencyMs: number;
};

export type VerifiableEpisode = {
  id: string;
  taskId: string;
  taskVersion: string;
  agentVersion: string;
  model: string;
  initialStateHash: string;
  finalStateHash: string;
  verifierResults: VerifierResult[];
  reward: RewardVector;
  terminatedBecause:
    | "success"
    | "failure"
    | "escalation"
    | "policy_refusal"
    | "step_limit";
};

export type ScoredEpisode = {
  eligibleForTraining: boolean;
  scalarReward: number;
  reasons: string[];
};

const finiteNonNegative = (value: number) =>
  Number.isFinite(value) && value >= 0;

/**
 * Score an episode only from independently recorded measurements.
 *
 * Critical verifiers are gates, not soft penalties: a policy or safety failure must never become a
 * useful training example merely because the task happened to succeed. The vector remains stored so
 * weights can change without rewriting historical evidence.
 */
export function scoreEpisode(episode: VerifiableEpisode): ScoredEpisode {
  const reasons: string[] = [];
  const r = episode.reward;

  if (!episode.initialStateHash || !episode.finalStateHash) {
    reasons.push("state hashes are required");
  }
  if (episode.verifierResults.length === 0) {
    reasons.push("at least one verifier is required");
  }
  if (
    episode.verifierResults.some(
      (result) =>
        !result.id ||
        !result.version ||
        !Number.isFinite(result.score) ||
        result.score < 0 ||
        result.score > 1,
    )
  ) {
    reasons.push(
      "verifier results must be versioned with scores from zero to one",
    );
  }
  const failedCritical = episode.verifierResults.filter(
    (result) => result.critical && !result.passed,
  );
  if (failedCritical.length > 0) {
    reasons.push(
      `critical verifier failed: ${failedCritical.map((result) => result.id).join(", ")}`,
    );
  }
  if (
    ![
      r.taskCorrectness,
      r.policyCompliance,
      r.unsupportedClaims,
      r.unnecessaryToolCalls,
      r.humanInterventions,
      r.costUsd,
      r.latencyMs,
    ].every(finiteNonNegative)
  ) {
    reasons.push("reward measurements must be finite and non-negative");
  }
  if (r.taskCorrectness > 1 || r.policyCompliance > 1) {
    reasons.push(
      "correctness and policy compliance must be normalized to zero or one",
    );
  }

  const eligibleForTraining =
    reasons.length === 0 &&
    episode.terminatedBecause === "success" &&
    r.taskCorrectness === 1 &&
    r.policyCompliance === 1;

  const scalarReward = eligibleForTraining
    ? 10 * r.taskCorrectness +
      2 * r.policyCompliance -
      2 * r.unsupportedClaims -
      0.05 * r.unnecessaryToolCalls -
      0.25 * r.humanInterventions -
      r.costUsd -
      r.latencyMs / 1_000_000
    : 0;

  if (!eligibleForTraining && reasons.length === 0) {
    reasons.push(
      "episode did not end in a fully correct, policy-compliant success",
    );
  }

  return { eligibleForTraining, scalarReward, reasons };
}
