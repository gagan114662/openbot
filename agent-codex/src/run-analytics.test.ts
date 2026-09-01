import { describe, expect, test } from "bun:test";
import { modelFromThreadStart, usageFromNotification } from "./run-analytics";

describe("Codex run analytics", () => {
  test("uses the model resolved by thread/start", () => {
    expect(
      modelFromThreadStart(
        { result: { model: "gpt-5.6-sol" } },
        "account default",
      ),
    ).toBe("gpt-5.6-sol");
  });

  test("reads last-turn usage rather than cumulative thread usage", () => {
    expect(
      usageFromNotification({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: { totalTokens: 999 },
            last: {
              inputTokens: 120,
              cachedInputTokens: 80,
              outputTokens: 14,
              reasoningOutputTokens: 3,
              totalTokens: 134,
            },
          },
        },
      }),
    ).toEqual({
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 14,
      reasoningOutputTokens: 3,
      totalTokens: 134,
    });
  });

  test("ignores unrelated or malformed notifications", () => {
    expect(usageFromNotification({ method: "turn/completed" })).toBeNull();
    expect(
      usageFromNotification({
        method: "thread/tokenUsage/updated",
        params: { tokenUsage: { last: { inputTokens: -1 } } },
      }),
    ).toEqual({});
  });
});
