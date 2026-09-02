import { describe, expect, test } from "bun:test";
import { managedWorkflowStages } from "./routes";

describe("managed workflow plans", () => {
  test.each([
    ["pull-request-review", ["inspect", "review"]],
    ["ci-repair", ["diagnose", "repair", "verify"]],
    ["bug-triage", ["reproduce", "diagnose", "recommend"]],
    ["visual-delivery", ["implement", "visual-verify"]],
  ] as const)("builds a real bounded DAG for %s", (kind, expectedIds) => {
    const stages = managedWorkflowStages(kind, "prove the production path", [
      "repository-policy",
    ]);
    expect(stages.map((stage) => stage.id)).toEqual([...expectedIds]);
    expect(
      stages.every((stage) => stage.requiredContext[0] === "repository-policy"),
    ).toBe(true);
    for (const [index, stage] of stages.entries()) {
      expect(stage.dependsOn).toEqual(
        index === 0 ? [] : [stages[index - 1]!.id],
      );
    }
  });
});
