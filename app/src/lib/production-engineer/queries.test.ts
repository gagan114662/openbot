import { describe, expect, test } from "bun:test";
import {
  fixAutomationMessage,
  tuningProposalFrom,
  workflowEventDetail,
} from "./queries";

describe("workflow event evidence", () => {
  test("renders a stale-session refusal with both process identities", () => {
    expect(
      workflowEventDetail({
        reason: "stale-session",
        operation: "complete",
        expected: "live-process-session",
        actual: "stale-process-session",
      }),
    ).toBe(
      "refused stale complete · owner live-process-session · caller stale-process-session",
    );
    expect(workflowEventDetail({ reason: "ordinary-transition" })).toBeNull();
  });
});

describe("production tuning proposals", () => {
  test("admits the persisted proposal shape rendered to an operator", () => {
    expect(
      tuningProposalFrom({
        currentThreshold: 3,
        proposedThreshold: 4,
        reason: "50% of firings were marked noise",
        requiresApproval: true,
      }),
    ).toEqual({
      currentThreshold: 3,
      proposedThreshold: 4,
      reason: "50% of firings were marked noise",
      requiresApproval: true,
    });
  });

  test("does not render a partial or corrupted database value", () => {
    expect(
      tuningProposalFrom({ proposedThreshold: 4, reason: "missing fields" }),
    ).toBeNull();
  });
});

describe("production fix gate copy", () => {
  test("explains the operator action instead of presenting an unexplained disabled button", () => {
    expect(fixAutomationMessage(false)).toContain(
      "PRODUCTION_ENGINEER_FIX_AUTOMATION=true",
    );
    expect(fixAutomationMessage(true)).toContain("administrator click");
    expect(fixAutomationMessage(true)).toContain("never merges directly");
  });
});
