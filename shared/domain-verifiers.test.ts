import { describe, expect, test } from "bun:test";
import {
  verifyGrounding,
  verifyMoneyTotal,
  verifyRiskFlags,
} from "./domain-verifiers";

describe("fintech deterministic verifiers", () => {
  test("money stays integer code, including adjustments", () => {
    expect(
      verifyMoneyTotal({
        lineItemCents: [10_000, -500, 250],
        reportedTotalCents: 9_750,
      }).passed,
    ).toBe(true);
    expect(
      verifyMoneyTotal({
        lineItemCents: [10_000, -500, 250],
        reportedTotalCents: 9_751,
      }).passed,
    ).toBe(false);
  });

  test("a citation must name a source actually retrieved", () => {
    const result = verifyGrounding({
      retrievedSourceIds: ["policy-1"],
      claims: [{ text: "Unsupported", sourceIds: ["policy-2"] }],
    });
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result.evidence)).not.toContain("Unsupported");
  });

  test("risk flags are independently recomputed from transactions", () => {
    const transactions = [
      {
        accountId: "a",
        amountCents: 10_000_000,
        country: "CA",
        occurredAt: "2026-01-01T00:00:00Z",
      },
      {
        accountId: "a",
        amountCents: 1,
        country: "XZ",
        occurredAt: "2026-01-01T00:10:00Z",
      },
      {
        accountId: "a",
        amountCents: 1,
        country: "CA",
        occurredAt: "2026-01-01T00:20:00Z",
      },
    ];
    expect(
      verifyRiskFlags({
        transactions,
        sanctionedCountries: ["XZ"],
        reportedFlags: [
          "high_value",
          "rapid_velocity",
          "sanctioned_jurisdiction",
        ],
      }).passed,
    ).toBe(true);
    expect(
      verifyRiskFlags({
        transactions,
        sanctionedCountries: ["XZ"],
        reportedFlags: [],
      }).passed,
    ).toBe(false);
  });
});
