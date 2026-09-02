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

export type WorkerResult = {
  workUnitId: string;
  summary: string;
  evidence: string[];
  costMicros: number;
};

export type FactoryJob = {
  id: string;
  kind: ManagedJobKind;
  tier: ExecutionTier;
  objective: string;
  maximumAttempts: number;
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
  }): Promise<WorkerResult>;
  judge(input: { job: FactoryJob; results: WorkerResult[] }): Promise<{
    accepted: boolean;
    reason: string;
  }>;
};

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

/**
 * A frontier judge owns decomposition and acceptance. Workers see only the context keys selected
 * for their bounded unit, and independent units may run concurrently on cheaper routed models.
 */
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
  const units = await executor.plan(job);
  assertPlan(units);
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
      ready.map(async (unit) => {
        const [route, context] = await Promise.all([
          executor.route(unit, job),
          executor.ground(unit.requiredContext),
        ]);
        return executor.work({
          job,
          unit,
          route,
          context,
          priorResults: [...results],
        });
      }),
    );
    for (const result of completed) {
      if (!pending.delete(result.workUnitId))
        throw new Error(
          `Worker returned an unknown work-unit id: ${result.workUnitId}`,
        );
      results.push(result);
    }
  }
  const verdict = await executor.judge({ job, results });
  return {
    jobId: job.id,
    accepted: verdict.accepted,
    reason: verdict.reason,
    results,
    totalCostMicros: results.reduce(
      (sum, result) => sum + result.costMicros,
      0,
    ),
  };
}
