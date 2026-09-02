import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { WebhookReconciler } from "../webhooks/reconciler";
import type { ContextGraph, ContextNodeInput } from "./context-graph";
import {
  type ExecutionTier,
  executionTiers,
  type ModelBenchmark,
} from "./model-router";
import { type ManagedJobKind, managedJobKinds } from "./orchestrator";
import type { ShadowEvaluator } from "./shadow-evaluator";
import type { SoftwareFactoryStore } from "./store";
import type { WorkflowRuntime } from "./workflow-runtime";

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const nonempty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function managedWorkflowStages(
  kind: ManagedJobKind,
  objective: string,
  requiredContext: string[],
) {
  const diffCheck = {
    id: "diff-integrity",
    command: ["git", "diff", "--check"],
    timeoutMs: 30_000,
    required: true,
  };
  const focusedFactoryChecks = [
    diffCheck,
    {
      id: "factory-focused-tests",
      command: [
        "bun",
        "test",
        "server/src/software-factory/orchestrator.test.ts",
        "server/src/software-factory/routes.test.ts",
        "server/src/software-factory/workflow-evidence.test.ts",
      ],
      timeoutMs: 120_000,
      required: true,
    },
    {
      id: "server-typecheck",
      command: ["bun", "run", "--cwd", "server", "typecheck"],
      timeoutMs: 120_000,
      required: true,
    },
    {
      id: "repository-lint",
      command: ["bun", "run", "lint"],
      timeoutMs: 120_000,
      required: true,
    },
  ];
  const stage = (
    id: string,
    purpose: string,
    dependsOn: string[] = [],
    checks = [diffCheck],
  ) => ({
    id,
    objective: `${purpose}. Overall objective: ${objective}`,
    requiredContext,
    dependsOn,
    checks,
  });
  switch (kind) {
    case "pull-request-review":
      return [
        stage(
          "inspect",
          "Inspect the change and establish revision-bound evidence",
        ),
        stage("review", "Independently review correctness and risk", [
          "inspect",
        ]),
      ];
    case "ci-repair":
      return [
        stage(
          "diagnose",
          "Reproduce the reported CI state and diagnose any failing checks",
          [],
          focusedFactoryChecks,
        ),
        stage(
          "repair",
          "Implement the smallest evidence-backed repair, or preserve the clean tree when no repair is required",
          ["diagnose"],
        ),
        stage(
          "verify",
          "Run deterministic regression checks",
          ["repair"],
          focusedFactoryChecks,
        ),
      ];
    case "bug-triage":
      return [
        stage("reproduce", "Reproduce the reported behavior"),
        stage("diagnose", "Identify the causal root issue", ["reproduce"]),
        stage(
          "recommend",
          "Produce a bounded remediation with evidence",
          ["diagnose"],
          focusedFactoryChecks,
        ),
      ];
    case "visual-delivery":
      return [
        stage("implement", "Implement the requested user-visible change"),
        stage(
          "visual-verify",
          "Verify the rendered behavior and regression checks",
          ["implement"],
          focusedFactoryChecks,
        ),
      ];
  }
}

export function createSoftwareFactoryRoutes(
  store: SoftwareFactoryStore,
  graph: ContextGraph,
  tenantId: string,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  webhooks?: WebhookReconciler,
  shadows?: ShadowEvaluator,
  workflows?: WorkflowRuntime,
  provenance?: {
    revision: string;
    branch: string;
    dirty: boolean;
    workerId?: string;
  },
  auditStore?: AuditStore,
  worktreeStats?: () => Promise<{ active: number; diskBytes: number }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.get("/", async (context) =>
    context.json({
      ...(await store.dashboard()),
      contextGraph: await graph.stats(tenantId),
      executionTiers,
      managedJobKinds,
      webhooks: webhooks ? await webhooks.dashboard() : null,
      shadowTraffic: shadows ? await shadows.dashboard() : null,
      workflows: workflows ? await workflows.list() : [],
      contextCapsules: workflows ? await workflows.listContextCapsules() : [],
      provenance: provenance ?? null,
      worktrees: worktreeStats
        ? await worktreeStats()
        : { active: 0, diskBytes: 0 },
    }),
  );
  routes.post("/benchmarks", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const model = nonempty(body?.model);
    const task = nonempty(body?.task);
    const harness = nonempty(body?.harness) ?? "codex";
    if (!model || !task || !["codex", "claude"].includes(harness))
      return context.json(
        { error: "Model, task, and a valid harness are required." },
        400,
      );
    await store.benchmark({
      harness: harness as "codex" | "claude",
      model,
      task,
      quality: Number(body?.quality),
      successfulOutcomes: Number(body?.successfulOutcomes),
      attemptedOutcomes: Number(body?.attemptedOutcomes),
      totalCostMicros: Number(body?.totalCostMicros),
      enabled: body?.enabled !== false,
    } satisfies ModelBenchmark);
    return context.json({ saved: true }, 201);
  });
  routes.post("/jobs", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const kind = nonempty(body?.kind);
    const tier = nonempty(body?.tier);
    const objective = nonempty(body?.objective);
    const trigger = nonempty(body?.trigger);
    const requiredContext = Array.isArray(body?.requiredContext)
      ? [
          ...new Set(
            body.requiredContext
              .filter((key): key is string => typeof key === "string")
              .map((key) => key.trim())
              .filter(Boolean),
          ),
        ].slice(0, 50)
      : [];
    if (
      !kind ||
      !managedJobKinds.includes(kind as ManagedJobKind) ||
      !tier ||
      !executionTiers.includes(tier as ExecutionTier) ||
      !objective ||
      !trigger
    )
      return context.json(
        { error: "A valid kind, tier, objective, and trigger are required." },
        400,
      );
    const queued = await store.queueJob(context.var.actor.id, {
      kind: kind as ManagedJobKind,
      tier: tier as ExecutionTier,
      objective,
      trigger,
      minimumQuality: Number(body?.minimumQuality ?? 0.8),
    });
    const workflow = workflows
      ? await workflows.create({
          jobId: queued.job.id,
          maximumAttempts: Number(body?.maximumAttempts ?? 3),
          concurrencyLimit: Number(body?.concurrencyLimit ?? 1),
          stages: managedWorkflowStages(
            kind as ManagedJobKind,
            objective,
            requiredContext,
          ),
        })
      : null;
    return context.json({ ...queued, workflow }, 201);
  });
  routes.post("/jobs/:jobId/outcome", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    if (typeof body?.success !== "boolean")
      return context.json(
        { error: "A verified success verdict is required." },
        400,
      );
    return context.json(
      await store.completeJob(context.req.param("jobId"), {
        success: body.success,
        costMicros: Number(body.costMicros),
        outcome: record(body.outcome) ?? {},
      }),
    );
  });
  routes.post("/context/nodes", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const input = {
      key: nonempty(body?.key),
      kind: nonempty(body?.kind),
      title: nonempty(body?.title),
      value: nonempty(body?.value),
      sourceSystem: nonempty(body?.sourceSystem),
      sourceUrl: nonempty(body?.sourceUrl) ?? undefined,
      refreshedAt: body?.refreshedAt
        ? new Date(String(body.refreshedAt))
        : new Date(),
    };
    if (
      !input.key ||
      !input.kind ||
      !input.title ||
      !input.value ||
      !input.sourceSystem ||
      Number.isNaN(input.refreshedAt.valueOf())
    )
      return context.json({ error: "A valid context node is required." }, 400);
    return context.json(
      await graph.upsertNode(tenantId, input as ContextNodeInput),
      201,
    );
  });
  routes.post("/context/edges", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const fromKey = nonempty(body?.fromKey);
    const toKey = nonempty(body?.toKey);
    const relation = nonempty(body?.relation);
    if (!fromKey || !toKey || !relation)
      return context.json(
        { error: "Both nodes and a relation are required." },
        400,
      );
    await graph.connect(tenantId, {
      fromKey,
      toKey,
      relation,
      evidence: body?.evidence,
    });
    return context.json({ connected: true }, 201);
  });
  routes.post("/context/ground", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const keys = Array.isArray(body?.keys)
      ? body.keys.filter((key): key is string => typeof key === "string")
      : [];
    return context.json({ nodes: await graph.ground(tenantId, keys) });
  });
  routes.post("/webhooks/dead/:eventId/replay", async (context) => {
    if (!webhooks) return context.notFound();
    return context.json(
      await webhooks.replayDead(context.req.param("eventId")),
    );
  });
  routes.post("/workflows", async (context) => {
    if (!workflows) return context.notFound();
    const body = record(await context.req.json().catch(() => null));
    const jobId = nonempty(body?.jobId);
    if (!jobId) return context.json({ error: "A job id is required." }, 400);
    return context.json(
      await workflows.create({
        jobId,
        stages: body?.stages,
        maximumAttempts: Number(body?.maximumAttempts ?? 3),
        concurrencyLimit: Number(body?.concurrencyLimit ?? 2),
      }),
      201,
    );
  });
  routes.get("/workflows/:runId", async (context) => {
    if (!workflows) return context.notFound();
    const snapshot = await workflows.snapshot(context.req.param("runId"));
    return snapshot ? context.json(snapshot) : context.notFound();
  });
  routes.get("/workflows/:runId/evidence", async (context) => {
    if (!workflows) return context.notFound();
    const snapshot = await workflows.snapshot(context.req.param("runId"));
    return snapshot
      ? context.json({
          runId: snapshot.run.id,
          revision: provenance?.revision ?? null,
          ...snapshot.evidence,
          stages: snapshot.stages,
          artifacts: snapshot.artifacts,
          events: snapshot.events,
        })
      : context.notFound();
  });
  routes.get("/context-capsules/:id", async (context) => {
    if (!workflows) return context.notFound();
    const artifact = await workflows.contextCapsule(context.req.param("id"));
    return artifact ? context.json(artifact) : context.notFound();
  });
  routes.post("/workflows/:runId/:action", async (context) => {
    if (!workflows) return context.notFound();
    const runId = context.req.param("runId");
    const action = context.req.param("action");
    const body = record(await context.req.json().catch(() => null));
    const before = await workflows.snapshot(runId);
    const approve = async () => {
      const actorId = context.var.actor.id;
      const approved = await workflows.approve(runId, actorId);
      const run =
        approved ??
        ((await workflows.snapshot(runId))?.run.status === "succeeded"
          ? (await workflows.snapshot(runId))?.run
          : null);
      if (!run) return null;
      await store.completeJob(run.jobId, {
        success: true,
        costMicros: 0,
        outcome: {
          workflowRunId: run.id,
          verified: true,
          approvedBy: run.approvedBy ?? actorId,
          costBasis: "codex-subscription",
        },
      });
      return run;
    };
    const result =
      action === "pause"
        ? await workflows.requestPause(runId)
        : action === "resume"
          ? await workflows.resume(runId)
          : action === "abort"
            ? await workflows.requestAbort(runId)
            : action === "approve"
              ? await approve()
              : action === "steer" && nonempty(body?.instruction)
                ? await workflows.steer(
                    runId,
                    context.var.actor.id,
                    nonempty(body?.instruction) as string,
                  )
                : null;
    if (!result)
      return context.json(
        { error: "The workflow action is invalid for its current state." },
        409,
      );
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "workflow.control_applied",
        targetType: "factory_workflow_run",
        targetId: runId,
        actorUserId: context.var.actor.id,
        payload: {
          action,
          jobId: result.jobId,
          fromStatus: before?.run.status ?? null,
          toStatus: result.status,
          ...(action === "steer"
            ? {
                instructionHash: createHash("sha256")
                  .update(nonempty(body?.instruction) ?? "")
                  .digest("hex"),
              }
            : {}),
        },
      });
    }
    return context.json({ run: result });
  });
  return routes;
}
