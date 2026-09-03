import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
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
      expect(stages[1]?.gate).toMatchObject({
        kind: "human",
        roles: ["admin"],
      });
    }
    if (kind === "pull-request-review")
      expect(stages[1]?.gate).toMatchObject({
        kind: "human",
        roles: ["admin"],
      });
  });

  test("binds a declared observable file hash to the terminal runtime gate", () => {
    const stages = managedWorkflowStages("ci-repair", "write the proof", [], {
      path: "PROOF.md",
      sha256: "a".repeat(64),
      expectedContent: "proved\n",
    });
    expect(stages.at(-1)?.checks.at(-1)).toEqual({
      id: "observable-change",
      command: [
        "bun",
        "scripts/verify-observable-change.ts",
        "--path",
        "PROOF.md",
        "--sha256",
        "a".repeat(64),
      ],
      timeoutMs: 30_000,
      required: true,
    });
    expect(stages[0]?.checks.some(({ id }) => id === "observable-change")).toBe(
      false,
    );
    expect(stages[0]?.objective).toContain("nonterminal stage");
    expect(stages.at(-1)?.objective).toContain("terminal stage");
  });
});

describe("managed workflow launch provenance", () => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "admin-1",
      email: "admin@example.test",
      role: "admin",
    });
    await next();
  };

  test("refuses a launch without a falsifiable observable change", async () => {
    const routes = createSoftwareFactoryRoutes(
      {} as never,
      {} as never,
      "tenant-1",
      requireUser,
    );
    const response = await routes.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "ci-repair",
        tier: "managed",
        objective: "claim success",
        trigger: "operator-ui",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("observable file change");
  });

  test("persists server-derived actor and launcher arguments", async () => {
    let queuedInput: Record<string, unknown> | undefined;
    let workflowInput: Record<string, unknown> | undefined;
    const routes = createSoftwareFactoryRoutes(
      {
        queueJob: async (_actorId: string, input: Record<string, unknown>) => {
          queuedInput = input;
          return { job: { id: "job-1" }, decision: { model: "model-1" } };
        },
      } as never,
      {} as never,
      "tenant-1",
      requireUser,
      undefined,
      undefined,
      {
        create: async (input: Record<string, unknown>) => {
          workflowInput = input;
          return { run: { id: "run-1" } };
        },
      } as never,
    );
    const response = await routes.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "ci-repair",
        tier: "managed",
        objective: "write exact proof",
        trigger: "factory-live-run",
        observableChange: { path: "PROOF.md", expectedContent: "proved\n" },
      }),
    });
    expect(response.status).toBe(201);
    expect(queuedInput?.launchMetadata).toMatchObject({
      launcher: "scripts/factory-live-run.ts",
      actorId: "admin-1",
      arguments: {
        objective: "write exact proof",
        observableChange: {
          path: "PROOF.md",
          sha256:
            "15ec80ab7455464f2f65af50f24b1ec10085d0e6f75a6e98ec3670e8ede0c8bd",
        },
      },
    });
    expect(workflowInput?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checks: expect.arrayContaining([
            expect.objectContaining({ id: "observable-change" }),
          ]),
        }),
      ]),
    );
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

describe("workflow live control surface", () => {
  test("streams a terminal workflow snapshot over authenticated SSE", async () => {
    const routes = createSoftwareFactoryRoutes(
      {} as never,
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
        snapshot: async () => ({
          run: { id: "run-live", status: "succeeded" },
          stages: [{ stageId: "verify", status: "succeeded" }],
          events: [{ id: "event-1", entity: "stage", toStatus: "succeeded" }],
          artifacts: [{ kind: "runtime-check", content: "1 passed" }],
        }),
      } as never,
    );

    const response = await routes.request("/workflows/run-live/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: snapshot");
    expect(body).toContain("runtime-check");
    expect(body).toContain("1 passed");
  });

  test("routes a stage rejection and its mandatory feedback to the durable runtime", async () => {
    const calls: unknown[][] = [];
    const routes = createSoftwareFactoryRoutes(
      {} as never,
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
        decideStageGate: async (...args: unknown[]) => {
          calls.push(args);
          return { stageId: "release", decision: "reject" };
        },
      } as never,
    );
    const response = await routes.request(
      "/workflows/run-1/stages/release/gate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject", feedback: "repair this" }),
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      ["run-1", "release", "admin-1", "reject", "repair this"],
    ]);
  });
});
