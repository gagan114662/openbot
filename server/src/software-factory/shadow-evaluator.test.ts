import { describe, expect, test } from "bun:test";
import { outputAgreement, shouldShadow } from "./shadow-evaluator";

describe("shadow traffic sampling", () => {
  test("is deterministic and honors hard endpoints", () => {
    expect(shouldShadow("same", 0)).toBe(false);
    expect(shouldShadow("same", 10_000)).toBe(true);
    expect(shouldShadow("same", 500)).toBe(shouldShadow("same", 500));
  });

  test("scores output agreement without retaining prompt content", () => {
    expect(outputAgreement("refund order 42", "refund order 42")).toBe(10_000);
    expect(outputAgreement("refund order", "cancel account")).toBe(0);
  });
});
