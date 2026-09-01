import { describe, expect, test } from "bun:test";
import { escalationOutcome } from "./escalation-tool";
import { UNANSWERED_TOOL_RESULT } from "./repair-history";

describe("escalation transcript outcome", () => {
  test("recognizes the deployment's explicit reached marker", () => {
    expect(escalationOutcome("Put to the person in this conversation.")).toBe(
      "reached",
    );
  });

  test("recognizes an explicit route refusal", () => {
    expect(escalationOutcome("Nobody is on call.")).toBe("refused");
  });

  test("keeps omitted and repaired results neutral", () => {
    expect(escalationOutcome(undefined)).toBe("unknown");
    expect(escalationOutcome("")).toBe("unknown");
    expect(escalationOutcome(UNANSWERED_TOOL_RESULT)).toBe("unknown");
  });
});
