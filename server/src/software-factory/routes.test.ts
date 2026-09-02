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
    const terminal = stages.at(-1)!;
    if (
      kind === "ci-repair" ||
      kind === "bug-triage" ||
      kind === "visual-delivery"
    ) {
      expect(terminal.checks.map((check) => check.id)).toEqual([
        "diff-integrity",
        "factory-focused-tests",
        "server-typecheck",
        "repository-lint",
      ]);
      expect(terminal.checks.every((check) => check.required)).toBe(true);
    }
    if (kind === "ci-repair") {
      expect(stages[0]?.checks.map((check) => check.id)).toEqual([
        "diff-integrity",
        "factory-focused-tests",
        "server-typecheck",
        "repository-lint",
      ]);
    }
  });
});
