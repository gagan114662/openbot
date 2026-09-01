import { createHash } from "node:crypto";
import type { VerifierResult } from "./verifiable-reward";

const evidenceHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function verifyMoneyTotal(input: {
  lineItemCents: number[];
  reportedTotalCents: number;
}): VerifierResult {
  const expected = input.lineItemCents.reduce((sum, value) => sum + value, 0);
  const passed =
    input.lineItemCents.every(Number.isSafeInteger) &&
    Number.isSafeInteger(input.reportedTotalCents) &&
    expected === input.reportedTotalCents;
  return {
    id: "money-total",
    version: "1.0.0",
    passed,
    score: passed ? 1 : 0,
    critical: true,
    evidence: { expectedCents: expected, observedHash: evidenceHash(input) },
  };
}

export function verifyGrounding(input: {
  retrievedSourceIds: string[];
  claims: Array<{ text: string; sourceIds: string[] }>;
}): VerifierResult {
  const retrieved = new Set(input.retrievedSourceIds);
  const unsupported = input.claims.filter(
    (claim) =>
      claim.sourceIds.length === 0 ||
      claim.sourceIds.some((source) => !retrieved.has(source)),
  );
  const passed = input.claims.length > 0 && unsupported.length === 0;
  return {
    id: "source-grounding",
    version: "1.0.0",
    passed,
    score:
      input.claims.length === 0
        ? 0
        : 1 - unsupported.length / input.claims.length,
    critical: true,
    evidence: {
      claimCount: input.claims.length,
      unsupportedClaimHashes: unsupported.map((claim) =>
        evidenceHash(claim.text),
      ),
      retrievedSetHash: evidenceHash([...retrieved].sort()),
    },
  };
}

type Transaction = {
  accountId: string;
  amountCents: number;
  country: string;
  occurredAt: string;
};

export function expectedRiskFlags(
  transactions: Transaction[],
  sanctionedCountries: string[],
): string[] {
  const flags = new Set<string>();
  const sanctioned = new Set(
    sanctionedCountries.map((country) => country.toUpperCase()),
  );
  for (const transaction of transactions) {
    if (transaction.amountCents >= 10_000_000) flags.add("high_value");
    if (sanctioned.has(transaction.country.toUpperCase())) {
      flags.add("sanctioned_jurisdiction");
    }
  }
  const byAccount = Map.groupBy(
    transactions,
    (transaction) => transaction.accountId,
  );
  for (const accountTransactions of byAccount.values()) {
    const ordered = accountTransactions
      .map((transaction) => Date.parse(transaction.occurredAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    for (let start = 0; start < ordered.length; start += 1) {
      if (
        (ordered[start + 2] ?? Number.POSITIVE_INFINITY) - ordered[start] <=
        3_600_000
      ) {
        flags.add("rapid_velocity");
        break;
      }
    }
  }
  return [...flags].sort();
}

export function verifyRiskFlags(input: {
  transactions: Transaction[];
  sanctionedCountries: string[];
  reportedFlags: string[];
}): VerifierResult {
  const expected = expectedRiskFlags(
    input.transactions,
    input.sanctionedCountries,
  );
  const reported = [...new Set(input.reportedFlags)].sort();
  const passed = JSON.stringify(expected) === JSON.stringify(reported);
  return {
    id: "transaction-risk-flags",
    version: "1.0.0",
    passed,
    score: passed ? 1 : 0,
    critical: true,
    evidence: {
      expected,
      reported,
      transactionSetHash: evidenceHash(input.transactions),
    },
  };
}
