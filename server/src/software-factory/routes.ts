import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { WebhookReconciler } from "../webhooks/reconciler";
import type { FactoryBenchmarkRunner } from "./benchmark-runner";
import type { ContextGraph, ContextNodeInput } from "./context-graph";
import { type ExecutionTier, executionTiers } from "./model-router";
import { type ManagedJobKind, managedJobKinds } from "./orchestrator";
import type { ShadowEvaluator } from "./shadow-evaluator";
import type { SoftwareFactoryStore } from "./store";
import type { WorkflowRuntime } from "./workflow-runtime";
import { subscribeWorkflowEvents } from "./workflow-stream";

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
  observableChange?: { path: string; sha256: string },
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
      command: ["bun", "test", "__OPENBOT_CHANGED_TESTS__"],
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
    gate?: { kind: "human"; prompt: string; roles: string[] },
  ) => ({
    id,
    objective: purpose,
    requiredContext,
    dependsOn,
    checks: checks.map((check) => ({ ...check, command: [...check.command] })),
    ...(gate ? { gate } : {}),
  });
  let stages: ReturnType<typeof stage>[];
  switch (kind) {
    case "pull-request-review":
      stages = [
        stage(
          "inspect",
          "Inspect the change and establish revision-bound evidence",
        ),
        stage(
          "review",
          "Independently review correctness and risk",
          ["inspect"],
          [diffCheck],
          {
            kind: "human",
            prompt: "Approve the inspected revision before final review",
            roles: ["admin"],
          },
        ),
      ];
      break;
    case "ci-repair":
      stages = [
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
          [diffCheck],
          {
            kind: "human",
            prompt: "Approve diagnosis before the repair changes the candidate",
            roles: ["admin"],
          },
        ),
        stage(
          "verify",
          "Run deterministic regression checks",
          ["repair"],
          focusedFactoryChecks,
        ),
      ];
      break;
    case "bug-triage":
      stages = [
        stage("reproduce", "Reproduce the reported behavior"),
        stage("diagnose", "Identify the causal root issue", ["reproduce"]),
        stage(
          "recommend",
          "Produce a bounded remediation with evidence",
          ["diagnose"],
          focusedFactoryChecks,
        ),
      ];
      break;
    case "visual-delivery":
      stages = [
        stage("implement", "Implement the requested user-visible change"),
        stage(
          "visual-verify",
          "Verify the rendered behavior and regression checks",
          ["implement"],
          focusedFactoryChecks,
        ),
      ];
      break;
  }
  const terminalIndex = stages.length - 1;
  stages.forEach((plannedStage, index) => {
    plannedStage.objective +=
      index === terminalIndex
        ? `. This is the terminal stage: satisfy the overall objective now: ${objective}`
        : `. This is a nonterminal stage: use the overall objective only as context and do not require its final deliverable yet: ${objective}`;
  });
  if (observableChange) {
    const terminal = stages.at(-1);
    if (!terminal) throw new Error("Managed workflow has no terminal stage.");
    terminal.objective += ` Produce the objective-driven observable change in ${observableChange.path}. The runtime validates the expected artifact independently; its expected bytes and digest are intentionally withheld from every model prompt.`;
    terminal.checks.push({
      id: "observable-change",
      command: [
        "bun",
        "scripts/verify-observable-change.ts",
        "--path",
        observableChange.path,
        "--sha256",
        observableChange.sha256,
      ],
      timeoutMs: 30_000,
      required: true,
    });
  }
  return stages;
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
  cleanupWorktree?: (runId: string) => Promise<void>,
  benchmarkRunner?: FactoryBenchmarkRunner,
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
      benchmarkRuns: benchmarkRunner
        ? await benchmarkRunner.dashboard()
        : { runs: [], outcomes: [] },
    }),
  );
  routes.get("/metrics", async (context) => {
    const stats = worktreeStats
      ? await worktreeStats()
      : { active: 0, diskBytes: 0 };
    return context.text(
      [
        "# HELP factory_worktrees_active Active managed-workflow Git worktrees.",
        "# TYPE factory_worktrees_active gauge",
        `factory_worktrees_active ${stats.active}`,
        "# HELP factory_worktrees_disk_bytes Bytes consumed by managed-workflow Git worktrees.",
        "# TYPE factory_worktrees_disk_bytes gauge",
        `factory_worktrees_disk_bytes ${stats.diskBytes}`,
        "",
      ].join("\n"),
      200,
      { "content-type": "text/plain; version=0.0.4" },
    );
  });
  routes.post("/benchmarks", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    if (
      body?.quality !== undefined ||
      body?.successfulOutcomes !== undefined ||
      body?.attemptedOutcomes !== undefined ||
      body?.totalCostMicros !== undefined
    )
      return context.json(
        {
          error: "Benchmark metrics must come from an executed benchmark run.",
        },
        400,
      );
    return context.json({ error: "Use POST /benchmarks/:id/run." }, 400);
  });
  routes.post("/benchmarks/:id/run", async (context) => {
    if (!benchmarkRunner) return context.notFound();
    const benchmarkId = context.req.param("id");
    if (!(benchmarkId in benchmarkRunner.catalog))
      return context.json({ error: "Unknown benchmark task." }, 404);
    const result = await benchmarkRunner.start(
      context.var.actor.id,
      benchmarkId as keyof typeof benchmarkRunner.catalog,
    );
    return context.json(result, 202);
  });
  routes.post("/jobs", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const kind = nonempty(body?.kind);
    const tier = nonempty(body?.tier);
    const objective = nonempty(body?.objective);
    const trigger = nonempty(body?.trigger);
    const observable = record(body?.observableChange);
    const observablePath = nonempty(observable?.path);
    const observableContent =
      typeof observable?.expectedContent === "string"
        ? observable.expectedContent
        : null;
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
      !trigger ||
      !observablePath ||
      observableContent === null ||
      observableContent.length > 10_000 ||
      observablePath.length > 240 ||
      observablePath.startsWith("/") ||
      observablePath.includes("\\") ||
      observablePath.split("/").some((part) => part === ".." || !part)
    )
      return context.json(
        {
          error:
            "A valid kind, tier, objective, trigger, and safe observable file change are required.",
        },
        400,
      );
    const observableChange = {
      path: observablePath,
      sha256: createHash("sha256").update(observableContent).digest("hex"),
      expectedContent: observableContent,
    };
    const queued = await store.queueJob(context.var.actor.id, {
      kind: kind as ManagedJobKind,
      tier: tier as ExecutionTier,
      objective,
      trigger,
      minimumQuality: Number(body?.minimumQuality ?? 0.8),
      launchMetadata: {
        launcher:
          trigger === "factory-live-run"
            ? "scripts/factory-live-run.ts"
            : "operator-ui",
        actorId: context.var.actor.id,
        arguments: {
          kind,
          tier,
          objective,
          maximumAttempts: Number(body?.maximumAttempts ?? 3),
          concurrencyLimit: Number(body?.concurrencyLimit ?? 1),
          requiredContext,
          observableChange: {
            path: observableChange.path,
            sha256: observableChange.sha256,
          },
        },
      },
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
            observableChange,
          ),
        })
      : null;
    return context.json({ ...queued, workflow }, 201);
  });
  routes.post("/jobs/:jobId/outcome", async (context) => {
    return context.json(
      {
        error:
          "Manual outcomes are disabled; workflow checks, fresh review, and approval derive outcomes.",
      },
      410,
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
  routes.get("/workflows/:runId/events", async (context) => {
    if (!workflows) return context.notFound();
    const runId = context.req.param("runId");
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, value: unknown) =>
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
            ),
          );
        const snapshot = await workflows.snapshot(runId);
        if (!snapshot) {
          send("error", { error: "Workflow not found." });
          controller.close();
          return;
        }
        send("snapshot", snapshot);
        if (["succeeded", "failed", "aborted"].includes(snapshot.run.status)) {
          controller.close();
          return;
        }
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let unsubscribe = () => {};
        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          controller.close();
        };
        unsubscribe = subscribeWorkflowEvents(runId, (event) => {
          if (closed) return;
          send(event.type, event);
        });
        heartbeat = setInterval(
          () => send("heartbeat", { at: new Date().toISOString() }),
          15_000,
        );
        heartbeat.unref?.();
        context.req.raw.signal.addEventListener("abort", close, { once: true });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
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
  routes.get("/workflows/:runId/artifacts/:artifactId", async (context) => {
    if (!workflows) return context.notFound();
    const snapshot = await workflows.snapshot(context.req.param("runId"));
    const artifact = snapshot?.artifacts.find(
      ({ id }) => id === context.req.param("artifactId"),
    );
    return artifact
      ? context.json({
          id: artifact.id,
          runId: artifact.runId,
          stageId: artifact.stageId,
          kind: artifact.kind,
          uri: artifact.uri,
          checksum: artifact.checksum,
          revision: artifact.revision,
          producerSessionId: artifact.producerSessionId,
          command: artifact.command,
          exitCode: artifact.exitCode,
          content: artifact.content,
        })
      : context.notFound();
  });
  routes.get("/context-capsules/:id", async (context) => {
    if (!workflows) return context.notFound();
    const artifact = await workflows.contextCapsule(context.req.param("id"));
    return artifact ? context.json(artifact) : context.notFound();
  });
  routes.post("/workflows/:runId/stages/:stageId/decision", async (context) => {
    if (!workflows) return context.notFound();
    const body = record(await context.req.json().catch(() => null));
    const decision = nonempty(body?.decision);
    if (decision !== "approve" && decision !== "reject")
      return context.json(
        { error: "Decision must be approve or reject." },
        400,
      );
    const result = await workflows.decideStageGate(
      context.req.param("runId"),
      context.req.param("stageId"),
      {
        actorId: context.var.actor.id,
        actorRole: context.var.actor.role,
        decision,
        feedback: nonempty(body?.feedback) ?? undefined,
        producerStageId: nonempty(body?.producerStageId) ?? undefined,
        revision: provenance?.revision ?? "runtime-control",
      },
    );
    if (result?.status === "forbidden")
      return context.json({ error: "This role cannot decide this gate." }, 403);
    return result
      ? context.json({ gate: result })
      : context.json({ error: "No pending human gate was found." }, 409);
  });
  routes.post("/workflows/:runId/:action", async (context) => {
    if (!workflows) return context.notFound();
    const runId = context.req.param("runId");
    const action = context.req.param("action");
    const body = record(await context.req.json().catch(() => null));
    const before = await workflows.snapshot(runId);
    const actorId = context.var.actor.id;
    const fromStatus = before?.run.status ?? "unknown";
    const instruction = nonempty(body?.instruction);
    const instructionHash = instruction
      ? createHash("sha256").update(instruction).digest("hex")
      : undefined;
    const approve = async () => {
      const approved = await workflows.approve(
        runId,
        { id: actorId, role: "admin" },
        { fromStatus },
      );
      const afterApproval = approved ? null : await workflows.snapshot(runId);
      const run =
        approved ??
        (afterApproval?.run.status === "succeeded"
          ? Object.assign(afterApproval.run, {
              controlAuditPersisted: true,
            })
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
        ? await workflows.requestPause(runId, { actorId, fromStatus })
        : action === "resume"
          ? await workflows.resume(runId, { actorId, fromStatus })
          : action === "abort"
            ? await workflows.requestAbort(runId, { actorId, fromStatus })
            : action === "approve"
              ? await approve()
              : action === "steer" && instruction && instructionHash
                ? await workflows.steer(runId, actorId, instruction, {
                    fromStatus,
                    instructionHash,
                  })
                : null;
    if (!result)
      return context.json(
        { error: "The workflow action is invalid for its current state." },
        409,
      );
    if (action === "abort") await cleanupWorktree?.(runId);
    if (auditStore && !("controlAuditPersisted" in result)) {
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
                instructionHash,
              }
            : {}),
        },
      });
    }
    return context.json({ run: result });
  });
  return routes;
}
