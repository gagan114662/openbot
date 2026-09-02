import { describe, expect, test } from "bun:test";
import { verifyRuntimeEpisode } from "../src/analytics/runtime-verification";

const run = {
  runId: "run-1",
  threadId: "thread-1",
  messages: [{ id: "u", role: "user" as const, content: "verify it" }],
  tools: [],
  state: {},
  forwardedProps: {},
};

describe("live verifiable episodes", () => {
  test("accepts an answer grounded in an observed tool result", () => {
    const result = verifyRuntimeEpisode({
      run,
      requireGrounding: true,
      events: [
        {
          type: "TOOL_CALL_RESULT",
          toolCallId: "t",
          content: "source https://example.com/a",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m",
          delta: "See https://example.com/a",
        },
      ] as never,
    });
    expect(result.scored.eligibleForTraining).toBe(true);
    expect(result.episode.verifierResults[0]?.passed).toBe(true);
  });

  test("fails closed when a citation was not in live tool output", () => {
    const result = verifyRuntimeEpisode({
      run,
      requireGrounding: true,
      events: [
        {
          type: "TOOL_CALL_RESULT",
          toolCallId: "t",
          content: "source https://example.com/a",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m",
          delta: "See https://example.com/invented",
        },
      ] as never,
    });
    expect(result.scored.eligibleForTraining).toBe(false);
    expect(result.scored.reasons).toContain(
      "critical verifier failed: source-grounding",
    );
  });

  test("runs a critical money verifier against a typed live tool result", () => {
    const result = verifyRuntimeEpisode({
      run,
      requireGrounding: false,
      events: [
        {
          type: "TOOL_CALL_RESULT",
          toolCallId: "money",
          // AG-UI's result helper emits formatted JSON. Preserve the event as
          // one document: splitting it on newlines silently drops the typed
          // verifier contract.
          content: JSON.stringify(
            {
              openbotVerifier: {
                kind: "money-total",
                lineItemCents: [125, 375],
                reportedTotalCents: 499,
              },
            },
            null,
            2,
          ),
        },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "$4.99" },
      ] as never,
    });
    expect(result.scored.eligibleForTraining).toBe(false);
    expect(result.episode.verifierResults.map((item) => item.id)).toContain(
      "money-total",
    );
  });

  test("fails closed and exposes artifact debt for human review", () => {
    const result = verifyRuntimeEpisode({
      run,
      requireGrounding: false,
      events: [
        {
          type: "RUN_ERROR",
          message: "Debt review required",
          openbotDebt: {
            metrics: { complexityPoints: 90 },
            changedPaths: ["src/new.ts"],
            violations: ["complexityPoints 90 exceeds 80"],
          },
        },
      ] as never,
    });
    expect(result.scored.eligibleForTraining).toBe(false);
    expect(result.episode.verifierResults).toContainEqual(
      expect.objectContaining({ id: "technical-debt-budget", passed: false }),
    );
  });
});
