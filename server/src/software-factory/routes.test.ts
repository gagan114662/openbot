import { describe, expect, test } from "bun:test";
import { createSoftwareFactoryRoutes, managedWorkflowStages } from "./routes";

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

describe("workflow control audit", () => {
  test.each([
    ["approve", "awaiting_approval", "succeeded"],
    ["abort", "running", "aborting"],
  ] as const)(
    "records %s with its state transition",
    async (action, from, to) => {
      const events: Array<Record<string, unknown>> = [];
      const run = { id: "run-1", jobId: "job-1", status: to, approvedBy: null };
      const routes = createSoftwareFactoryRoutes(
        {
          completeJob: async () => ({}),
        } as never,
        {} as never,
        "tenant-1",
        async (context, next) => {
          context.set("actor", {
            id: "admin-1",
            email: "admin@example.test",
            role: "admin",
          });
          await next();
        },
        undefined,
        undefined,
        {
          snapshot: async () => ({ run: { ...run, status: from } }),
          approve: async () => (action === "approve" ? run : null),
          requestAbort: async () => (action === "abort" ? run : null),
        } as never,
        undefined,
        {
          insert: async (event) => {
            events.push(event);
          },
        },
      );

      const response = await routes.request(`/workflows/run-1/${action}`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(200);
      expect(events).toEqual([
        expect.objectContaining({
          eventType: "workflow.control_applied",
          targetId: "run-1",
          actorUserId: "admin-1",
          payload: expect.objectContaining({
            action,
            jobId: "job-1",
            fromStatus: from,
            toStatus: to,
          }),
        }),
      ]);
    },
  );
});
