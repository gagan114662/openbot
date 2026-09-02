import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { WebhookReconciler } from "../webhooks/reconciler";
import type { ContextGraph, ContextNodeInput } from "./context-graph";
import {
  type ExecutionTier,
  executionTiers,
  type ModelBenchmark,
} from "./model-router";
import { type ManagedJobKind, managedJobKinds } from "./orchestrator";
import type { SoftwareFactoryStore } from "./store";

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const nonempty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function createSoftwareFactoryRoutes(
  store: SoftwareFactoryStore,
  graph: ContextGraph,
  tenantId: string,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  webhooks?: WebhookReconciler,
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
    }),
  );
  routes.post("/benchmarks", async (context) => {
    const body = record(await context.req.json().catch(() => null));
    const model = nonempty(body?.model);
    const task = nonempty(body?.task);
    if (!model || !task)
      return context.json({ error: "Model and task are required." }, 400);
    await store.benchmark({
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
    return context.json(
      await store.queueJob(context.var.actor.id, {
        kind: kind as ManagedJobKind,
        tier: tier as ExecutionTier,
        objective,
        trigger,
        minimumQuality: Number(body?.minimumQuality ?? 0.8),
      }),
      201,
    );
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
  return routes;
}
