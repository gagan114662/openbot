import { describe, expect, test } from "bun:test";
import { type VerifiableEpisode, scoreEpisode } from "./verifiable-reward";

const episode = (
  overrides: Partial<VerifiableEpisode> = {},
): VerifiableEpisode => ({
  id: "episode-1",
  taskId: "reconcile-ledger",
  taskVersion: "1",
  agentVersion: "git:abc123",
  model: "gpt-test",
  initialStateHash: "sha256:before",
  finalStateHash: "sha256:after",
  verifierResults: [
    {
      id: "totals-reconcile",
      version: "1",
      passed: true,
      score: 1,
      evidence: { expected: 42, actual: 42 },
      critical: true,
    },
  ],
  reward: {
    taskCorrectness: 1,
    policyCompliance: 1,
    unsupportedClaims: 0,
    unnecessaryToolCalls: 0,
    humanInterventions: 0,
    costUsd: 0.01,
    latencyMs: 1000,
  },
  terminatedBecause: "success",
  ...overrides,
});

describe("verifiable reward episodes", () => {
  test("admits a versioned, independently verified success", () => {
    const result = scoreEpisode(episode());
    expect(result.eligibleForTraining).toBe(true);
    expect(result.scalarReward).toBeGreaterThan(0);
  });

  test("a critical safety failure is a hard gate, not a small penalty", () => {
    const result = scoreEpisode(
      episode({
        verifierResults: [
          {
            id: "no-secret-egress",
            version: "1",
            passed: false,
            score: 0,
            evidence: { findingCount: 1 },
            critical: true,
          },
        ],
      }),
    );
    expect(result.eligibleForTraining).toBe(false);
    expect(result.scalarReward).toBe(0);
    expect(result.reasons[0]).toContain("no-secret-egress");
  });

  test("refusals and partial success never enter training", () => {
    expect(
      scoreEpisode(episode({ terminatedBecause: "policy_refusal" }))
        .eligibleForTraining,
    ).toBe(false);
    expect(
      scoreEpisode(
        episode({ reward: { ...episode().reward, taskCorrectness: 0 } }),
      ).eligibleForTraining,
    ).toBe(false);
  });

  test("rejects unverifiable or malformed measurements", () => {
    const result = scoreEpisode(
      episode({ initialStateHash: "", verifierResults: [] }),
    );
    expect(result.eligibleForTraining).toBe(false);
    expect(result.reasons).toContain("state hashes are required");
    expect(result.reasons).toContain("at least one verifier is required");
  });
});
