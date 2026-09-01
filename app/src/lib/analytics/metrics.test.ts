import { describe, expect, test } from "bun:test";
import { ratioPercent } from "./metrics";

describe("analytics percentages", () => {
  test("does not count unknown outcomes as task failures", () => {
    const sessions = 6;
    const evaluated = 1;
    const successful = 1;
    expect(ratioPercent(successful, evaluated)).toBe("100.0%");
    expect(ratioPercent(evaluated, sessions)).toBe("16.7%");
  });

  test("is defined before any evaluation exists", () => {
    expect(ratioPercent(0, 0)).toBe("0.0%");
  });
});
