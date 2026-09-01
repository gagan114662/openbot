import { describe, expect, test } from "bun:test";
import {
  handedToName,
  handoffOutcome,
  handoffResultDetail,
} from "./handoff-tool";
import { UNANSWERED_TOOL_RESULT } from "./repair-history";

describe("handoff transcript outcome", () => {
  test("calls only an explicit accepted marker accepted", () => {
    expect(
      handoffOutcome(
        "Handed to Knowledge. Its answer will be relayed into this conversation.",
      ),
    ).toBe("accepted");
  });

  test("calls an explicit server refusal refused", () => {
    expect(
      handoffOutcome(
        "You have not been given Risk Analyst to hand work to. An administrator grants that.",
      ),
    ).toBe("refused");
  });

  test("does not invent an outcome when AG-UI omitted the tool result", () => {
    expect(handoffOutcome(undefined)).toBe("unknown");
    expect(handoffOutcome("")).toBe("unknown");
    expect(handoffOutcome('""')).toBe("unknown");
    expect(handoffOutcome(UNANSWERED_TOOL_RESULT)).toBe("unknown");
    expect(handoffOutcome({ text: "not a wire result" })).toBe("unknown");
  });

  test("uses the authoritative display name in an accepted server result", () => {
    expect(
      handedToName(
        "Handed to Knowledge. Its answer will be relayed back into this conversation when it finishes.",
      ),
    ).toBe("Knowledge");
    expect(
      handedToName(
        '"Handed to Risk Analyst. Its answer will be relayed back into this conversation when it finishes."',
      ),
    ).toBe("Risk Analyst");
  });

  test("does not treat an argument or refusal as an authoritative name", () => {
    expect(handedToName("You have not been given Knowledge.")).toBeUndefined();
    expect(handedToName(undefined)).toBeUndefined();
  });

  test("hides only the synthetic missing-result warning for an asynchronous hop", () => {
    expect(handoffResultDetail(UNANSWERED_TOOL_RESULT)).toBeUndefined();
    expect(
      handoffResultDetail(JSON.stringify(UNANSWERED_TOOL_RESULT)),
    ).toBeUndefined();
    expect(handoffResultDetail("")).toBeUndefined();
    expect(handoffResultDetail("You have not been given Risk Analyst.")).toBe(
      "You have not been given Risk Analyst.",
    );
    expect(
      handoffResultDetail(
        '"Handed to Knowledge. Its answer will be relayed back into this conversation."',
      ),
    ).toBe(
      "Handed to Knowledge. Its answer will be relayed back into this conversation.",
    );
  });
});
