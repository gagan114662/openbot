import { describe, expect, test } from "bun:test";
import { UNANSWERED_TOOL_RESULT } from "./repair-history";
import { visibleToolHistoryResult } from "./tool-history-result";

describe("visible tool history results", () => {
  test("keeps protocol repair padding out of the human transcript", () => {
    expect(visibleToolHistoryResult(UNANSWERED_TOOL_RESULT)).toBeUndefined();
    expect(
      visibleToolHistoryResult(JSON.stringify(UNANSWERED_TOOL_RESULT)),
    ).toBeUndefined();
    expect(visibleToolHistoryResult("")).toBeUndefined();
  });

  test("keeps and unwraps actual server outcomes", () => {
    expect(visibleToolHistoryResult('"Found 3 matching files."')).toBe(
      "Found 3 matching files.",
    );
    expect(visibleToolHistoryResult("Refused. Policy denied it.")).toBe(
      "Refused. Policy denied it.",
    );
  });
});
