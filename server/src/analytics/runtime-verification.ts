import { createHash } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import {
  verifyGrounding,
  verifyMoneyTotal,
  verifyRiskFlags,
} from "../../../shared/domain-verifiers";
import {
  scoreEpisode,
  type VerifiableEpisode,
} from "../../../shared/verifiable-reward";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const urlsIn = (text: string) => {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const raw = match[0].replace(/[),.;:!?\]}]+$/g, "");
    try {
      const parsed = new URL(raw);
      // Fragments and a cosmetic trailing slash identify the same retrieved
      // document. This must match the evidence gate's lineage normalisation.
      parsed.hash = "";
      if (parsed.pathname.length > 1) {
        parsed.pathname = parsed.pathname.replace(/\/$/, "");
      }
      urls.add(parsed.toString());
    } catch {
      // URL-shaped malformed text is not evidence.
    }
  }
  return [...urls];
};

const textsFor = (events: readonly BaseEvent[], type: string) =>
  events
    .filter((event) => event.type === type)
    .map((event) =>
      "delta" in event && typeof event.delta === "string"
        ? event.delta
        : "content" in event && typeof event.content === "string"
          ? event.content
          : "",
    );

const textFor = (events: readonly BaseEvent[], type: string) =>
  textsFor(events, type).join("\n");

function jsonObjects(text: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return [parsed as Record<string, unknown>];
    }
  } catch {
    // Several tool results may still be represented as JSONL by direct callers; try each line.
  }
  const values: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        values.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Tool output is usually prose. Only explicit JSON contracts opt into domain verification.
    }
  }
  return values;
}

/**
 * Domain verification is opt-in by the tool result's typed payload, never inferred from prose.
 * A fintech connector can therefore return a normal result plus `openbotVerifier`; the runtime
 * independently recomputes the answer and a critical mismatch fails the same gate as grounding.
 */
export function domainResultsFromToolOutput(text: string) {
  return jsonObjects(text).flatMap((value) => {
    const contract = value.openbotVerifier;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      return [];
    }
    const typed = contract as Record<string, unknown>;
    try {
      if (
        typed.kind === "money-total" &&
        Array.isArray(typed.lineItemCents) &&
        typed.lineItemCents.every(Number.isSafeInteger) &&
        Number.isSafeInteger(typed.reportedTotalCents)
      ) {
        return [
          verifyMoneyTotal({
            lineItemCents: typed.lineItemCents as number[],
            reportedTotalCents: typed.reportedTotalCents as number,
          }),
        ];
      }
      if (
        typed.kind === "transaction-risk-flags" &&
        Array.isArray(typed.transactions) &&
        Array.isArray(typed.sanctionedCountries) &&
        Array.isArray(typed.reportedFlags)
      ) {
        return [
          verifyRiskFlags({
            transactions: typed.transactions as Parameters<
              typeof verifyRiskFlags
            >[0]["transactions"],
            sanctionedCountries: typed.sanctionedCountries as string[],
            reportedFlags: typed.reportedFlags as string[],
          }),
        ];
      }
    } catch {
      // A malformed verifier contract is itself a failed critical check below.
    }
    return [
      {
        id: "domain-contract",
        version: "1.0.0",
        passed: false,
        score: 0,
        critical: true,
        evidence: { contractHash: digest(contract) },
      },
    ];
  });
}

function debtResult(events: readonly BaseEvent[]) {
  for (const event of events) {
    const direct = (event as unknown as { openbotDebt?: unknown }).openbotDebt;
    const nested =
      "result" in event && event.result && typeof event.result === "object"
        ? (event.result as { openbotDebt?: unknown }).openbotDebt
        : undefined;
    const value = direct ?? nested;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const debt = value as {
      violations?: unknown;
      metrics?: unknown;
      changedPaths?: unknown;
    };
    const violations = Array.isArray(debt.violations)
      ? debt.violations.filter(
          (item): item is string => typeof item === "string",
        )
      : ["debt assessment was malformed"];
    return {
      id: "technical-debt-budget",
      version: "1.0.0",
      passed: violations.length === 0,
      score: violations.length === 0 ? 1 : 0,
      critical: true,
      evidence: {
        metrics: debt.metrics,
        changedPathCount: Array.isArray(debt.changedPaths)
          ? debt.changedPaths.length
          : 0,
        violations,
      },
    };
  }
  return null;
}

/** Construct and score the verifiable episode from live AG-UI tool/result events. */
export function verifyRuntimeEpisode(input: {
  run: RunAgentInput;
  events: readonly BaseEvent[];
  requireGrounding: boolean;
}) {
  const answer = textFor(input.events, "TEXT_MESSAGE_CONTENT");
  const toolResults = textsFor(input.events, "TOOL_CALL_RESULT");
  const toolOutput = toolResults.join("\n");
  const retrievedSourceIds = urlsIn(toolOutput);
  const cited = urlsIn(answer);
  const lifecycleOrGrounding = input.requireGrounding
    ? [
        verifyGrounding({
          retrievedSourceIds,
          claims: [{ text: answer, sourceIds: cited }],
        }),
      ]
    : [
        {
          id: "run-lifecycle",
          version: "1.0.0",
          passed: !input.events.some((event) => event.type === "RUN_ERROR"),
          score: input.events.some((event) => event.type === "RUN_ERROR")
            ? 0
            : 1,
          critical: true,
          evidence: {
            eventHash: digest(input.events.map((event) => event.type)),
          },
        },
      ];
  const verifierResults = [
    ...lifecycleOrGrounding,
    ...toolResults.flatMap(domainResultsFromToolOutput),
    ...(() => {
      const result = debtResult(input.events);
      return result ? [result] : [];
    })(),
  ];
  const toolCalls = input.events.filter(
    (event) => event.type === "TOOL_CALL_START",
  ).length;
  const episode: VerifiableEpisode = {
    id: input.run.runId,
    taskId: "openbot-live-run",
    taskVersion: "1",
    agentVersion: "runtime-v1",
    model: "runtime-selected",
    initialStateHash: digest(input.run.messages),
    finalStateHash: digest({ answer, toolResults: toolOutput }),
    verifierResults,
    reward: {
      taskCorrectness: verifierResults.every((result) => result.passed) ? 1 : 0,
      policyCompliance: input.events.some((event) => event.type === "RUN_ERROR")
        ? 0
        : 1,
      unsupportedClaims: verifierResults.filter((result) => !result.passed)
        .length,
      unnecessaryToolCalls: Math.max(0, toolCalls - 1),
      humanInterventions: 0,
      costUsd: 0,
      latencyMs: 0,
    },
    terminatedBecause: input.events.some((event) => event.type === "RUN_ERROR")
      ? "failure"
      : "success",
  };
  return { episode, scored: scoreEpisode(episode) };
}
