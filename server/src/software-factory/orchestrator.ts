import { z } from "zod";
import type { ExecutionTier, RoutingDecision } from "./model-router";

export const managedJobKinds = [
  "pull-request-review",
  "ci-repair",
  "bug-triage",
  "visual-delivery",
] as const;
export type ManagedJobKind = (typeof managedJobKinds)[number];
export type WorkUnit = {
  id: string;
  objective: string;
  requiredContext: string[];
  dependsOn: string[];
};
export type WorkerEvidence = {
  uri: string;
  checksum: string;
  revision: string;
  producerSessionId: string;
  command: string;
  exitCode: number;
};
export type WorkerResult = {
  workUnitId: string;
  producerSessionId: string;
  summary: string;
  evidence: WorkerEvidence[];
  costMicros: number;
};
export type FactoryJob = {
  id: string;
  kind: ManagedJobKind;
  tier: ExecutionTier;
  objective: string;
  maximumAttempts: number;
  concurrencyLimit?: number;
};
export type FactoryExecutor = {
  plan(job: FactoryJob): Promise<WorkUnit[]>;
  route(unit: WorkUnit, job: FactoryJob): Promise<RoutingDecision>;
  ground(
    keys: string[],
  ): Promise<Array<{ key: string; value: string; source: string }>>;
  work(input: {
    job: FactoryJob;
    unit: WorkUnit;
    route: RoutingDecision;
    context: Array<{ key: string; value: string; source: string }>;
    priorResults: WorkerResult[];
    attempt: number;
    repairReason: string | null;
  }): Promise<WorkerResult>;
  judge(input: {
    job: FactoryJob;
    results: WorkerResult[];
    attempt: number;
  }): Promise<{ accepted: boolean; reason: string; reviewerSessionId: string }>;
};

const workUnitSchema = z.object({
  id: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4_000),
  requiredContext: z.array(z.string().trim().min(1).max(500)).max(50),
  dependsOn: z.array(z.string().trim().min(1).max(200)).max(50),
});
const workerResultSchema = z.object({
  workUnitId: z.string().trim().min(1).max(200),
  producerSessionId: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(20_000),
  evidence: z
    .array(
      z.object({
        uri: z.string().trim().min(1).max(4_000),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.string().trim().min(1).max(500),
        producerSessionId: z.string().trim().min(1).max(500),
        command: z.string().trim().min(1).max(10_000),
        exitCode: z.number().int().min(-1).max(255),
      }),
    )
    .min(1)
    .max(100),
  costMicros: z.number().int().nonnegative(),
});
const verdictSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().trim().min(1).max(20_000),
  reviewerSessionId: z.string().trim().min(1).max(500),
});

const assertPlan = (units: WorkUnit[]) => {
  const ids = new Set(units.map((unit) => unit.id));
  if (ids.size !== units.length)
    throw new Error("The orchestrator produced duplicate work-unit ids.");
  for (const unit of units) {
    if (
      unit.dependsOn.includes(unit.id) ||
      unit.dependsOn.some((id) => !ids.has(id))
    )
      throw new Error(`Work unit ${unit.id} has an invalid dependency.`);
  }
};

/** Compatibility path with the durable runtime's core invariants: runtime schemas, bounded
 * concurrency and repair, provenance-bound evidence, and a fresh acceptance reviewer. */
export async function executeManagedJob(
  job: FactoryJob,
  executor: FactoryExecutor,
) {
  if (!managedJobKinds.includes(job.kind))
    throw new Error("Unknown managed job kind.");
  if (
    !Number.isSafeInteger(job.maximumAttempts) ||
    job.maximumAttempts < 1 ||
    job.maximumAttempts > 5
  )
    throw new Error(
      "Managed jobs require between one and five bounded attempts.",
    );
  const concurrencyLimit = job.concurrencyLimit ?? 1;
  if (
    !Number.isSafeInteger(concurrencyLimit) ||
    concurrencyLimit < 1 ||
    concurrencyLimit > 16
  )
    throw new Error(
      "Managed jobs require between one and sixteen concurrent workers.",
    );
  const units = z
    .array(workUnitSchema)
    .min(1)
    .max(100)
    .parse(await executor.plan(job));
  assertPlan(units);
  let repairReason: string | null = null;
  let totalCostMicros = 0;
  for (let attempt = 1; attempt <= job.maximumAttempts; attempt += 1) {
    const pending = new Map(units.map((unit) => [unit.id, unit]));
    const results: WorkerResult[] = [];
    while (pending.size > 0) {
      const ready = [...pending.values()].filter((unit) =>
        unit.dependsOn.every((dependency) =>
          results.some((result) => result.workUnitId === dependency),
        ),
      );
      if (ready.length === 0)
        throw new Error("The orchestrator plan contains a dependency cycle.");
      const completed = await Promise.all(
        ready.slice(0, concurrencyLimit).map(async (unit) => {
          const [route, context] = await Promise.all([
            executor.route(unit, job),
            executor.ground(unit.requiredContext),
          ]);
          const grounded = new Set(context.map((node) => node.key));
          if (unit.requiredContext.some((key) => !grounded.has(key)))
            throw new Error(`Trusted context is incomplete for ${unit.id}.`);
          return workerResultSchema.parse(
            await executor.work({
              job,
              unit,
              route,
              context,
              priorResults: [...results],
              attempt,
              repairReason,
            }),
          );
        }),
      );
      for (const result of completed) {
        if (!pending.delete(result.workUnitId))
          throw new Error(
            `Worker returned an unknown work-unit id: ${result.workUnitId}`,
          );
        if (
          result.evidence.some(
            (item) => item.producerSessionId !== result.producerSessionId,
          )
        )
          throw new Error(
            `Worker evidence producer mismatch for ${result.workUnitId}.`,
          );
        results.push(result);
        totalCostMicros += result.costMicros;
      }
    }
    const verdict = verdictSchema.parse(
      await executor.judge({ job, results, attempt }),
    );
    if (
      results.some(
        (result) => result.producerSessionId === verdict.reviewerSessionId,
      )
    )
      throw new Error(
        "The acceptance reviewer must use a fresh independent session.",
      );
    if (verdict.accepted)
      return {
        jobId: job.id,
        accepted: true,
        reason: verdict.reason,
        results,
        attempt,
        totalCostMicros,
      };
    repairReason = verdict.reason;
  }
  return {
    jobId: job.id,
    accepted: false,
    reason: repairReason ?? "The bounded repair loop exhausted its attempts.",
    results: [],
    attempt: job.maximumAttempts,
    totalCostMicros,
  };
}
