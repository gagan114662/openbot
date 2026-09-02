import { describe, expect, test } from "bun:test";
import { analyticsCostMicros } from "../src/analytics/store";

describe("analytics chargeback", () => {
  test("allocates token usage at explicitly configured internal rates", () => {
    expect(
      analyticsCostMicros(
        { inputTokens: 2_000, outputTokens: 500 },
        {
          ANALYTICS_CHARGEBACK_INPUT_USD_PER_MILLION_TOKENS: "2.5",
          ANALYTICS_CHARGEBACK_OUTPUT_USD_PER_MILLION_TOKENS: "10",
        },
      ),
    ).toBe(10_000);
  });

  test("provider-reported cost wins over internal allocation", () => {
    expect(
      analyticsCostMicros(
        { inputTokens: 2_000, outputTokens: 500, costMicros: 123 },
        {
          ANALYTICS_CHARGEBACK_INPUT_USD_PER_MILLION_TOKENS: "999",
          ANALYTICS_CHARGEBACK_OUTPUT_USD_PER_MILLION_TOKENS: "999",
        },
      ),
    ).toBe(123);
  });

  test("unset, invalid, and negative rates cannot invent spend", () => {
    expect(analyticsCostMicros({ inputTokens: 10, outputTokens: 20 }, {})).toBe(
      0,
    );
    expect(
      analyticsCostMicros(
        { inputTokens: 10, outputTokens: 20 },
        {
          ANALYTICS_CHARGEBACK_INPUT_USD_PER_MILLION_TOKENS: "nope",
          ANALYTICS_CHARGEBACK_OUTPUT_USD_PER_MILLION_TOKENS: "-2",
        },
      ),
    ).toBe(0);
  });
});
