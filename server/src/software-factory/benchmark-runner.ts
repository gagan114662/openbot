import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  factoryBenchmarkOutcomes,
  factoryBenchmarkRuns,
  factoryManagedJobs,
} from "../db/schema";
import {
  type FactoryBenchmarkId,
  factoryBenchmarkCatalog,
} from "./benchmark-catalog";
import type { SoftwareFactoryStore } from "./store";
import type { WorkflowRuntime } from "./workflow-runtime";

export function createFactoryBenchmarkRunner(options: {
  database: Database;
  tenantId: string;
  store: SoftwareFactoryStore;
  runtime: WorkflowRuntime;
  revision: string;
}) {
  return {
    catalog: factoryBenchmarkCatalog,

    async dashboard() {
      const runs = await options.database
        .select()
        .from(factoryBenchmarkRuns)
        .where(eq(factoryBenchmarkRuns.tenantId, options.tenantId))
        .orderBy(desc(factoryBenchmarkRuns.createdAt))
        .limit(20);
      const outcomes = runs.length
        ? await options.database
            .select()
            .from(factoryBenchmarkOutcomes)
            .where(
              inArray(
                factoryBenchmarkOutcomes.benchmarkRunId,
                runs.map((run) => run.id),
              ),
            )
        : [];
      return { runs, outcomes };
    },

    async start(actorId: string, benchmarkId: FactoryBenchmarkId) {
      const task = factoryBenchmarkCatalog[benchmarkId];
      if (!task) throw new Error("Unknown factory benchmark.");
      const [run] = await options.database
        .insert(factoryBenchmarkRuns)
        .values({
          tenantId: options.tenantId,
          task: task.id,
          revision: options.revision,
          createdBy: actorId,
        })
        .returning();
      if (!run) throw new Error("Could not create benchmark run.");
      const workflows = [];
      for (const pair of task.pairs) {
        const job = await options.store.queueBenchmarkJob({
          actorId,
          kind: task.kind,
          objective: task.objective,
          benchmarkRunId: run.id,
          ...pair,
        });
        const workflow = await options.runtime.create({
          jobId: job.id,
          maximumAttempts: 2,
          concurrencyLimit: 1,
          stages: [
            {
              id: "benchmark",
              objective: `${task.objective} Fixed revision: ${options.revision}.`,
              requiredContext: [],
              dependsOn: [],
              checks: task.checks.map((check) => ({
                ...check,
                command: [...check.command],
              })),
            },
          ],
        });
        workflows.push({ ...pair, workflowRunId: workflow.id });
      }
      return { run, workflows };
    },

    async recordWorkflow(
      snapshot: NonNullable<Awaited<ReturnType<WorkflowRuntime["snapshot"]>>>,
    ) {
      const [job] = await options.database
        .select({ launchMetadata: factoryManagedJobs.launchMetadata })
        .from(factoryManagedJobs)
        .where(eq(factoryManagedJobs.id, snapshot.run.jobId));
      const metadata = job?.launchMetadata as
        | {
            benchmarkRunId?: string;
            benchmarkPair?: { harness?: string; model?: string };
          }
        | undefined;
      const benchmarkRunId = metadata?.benchmarkRunId;
      const harness = metadata?.benchmarkPair?.harness;
      const model = metadata?.benchmarkPair?.model;
      if (
        !benchmarkRunId ||
        (harness !== "codex" && harness !== "claude") ||
        !model
      )
        return false;
      const [benchmarkRun] = await options.database
        .select()
        .from(factoryBenchmarkRuns)
        .where(
          and(
            eq(factoryBenchmarkRuns.id, benchmarkRunId),
            eq(factoryBenchmarkRuns.tenantId, options.tenantId),
          ),
        );
      if (!benchmarkRun) return false;
      const task =
        factoryBenchmarkCatalog[benchmarkRun.task as FactoryBenchmarkId];
      if (!task) return false;
      const stage = snapshot.stages.find(
        ({ stageId }) => stageId === "benchmark",
      );
      if (!stage || !["succeeded", "failed"].includes(stage.status))
        return false;
      const checks = new Map(
        snapshot.artifacts
          .filter(
            (artifact) =>
              artifact.stageId === "benchmark" &&
              artifact.kind === "runtime-check",
          )
          .map((artifact) => [
            String(
              (artifact.metadata as { checkId?: unknown } | null)?.checkId ??
                "",
            ),
            artifact,
          ]),
      );
      for (const check of task.checks) {
        const artifact = checks.get(check.id);
        await options.database
          .insert(factoryBenchmarkOutcomes)
          .values({
            benchmarkRunId,
            workflowRunId: snapshot.run.id,
            harness,
            model,
            checkId: check.id,
            passed: stage.status === "succeeded" && artifact?.exitCode === 0,
            wallTimeMs: Number(
              (artifact?.metadata as { durationMs?: unknown } | null)
                ?.durationMs ?? 0,
            ),
            repairAttempts: stage.attempts,
            tokens: null,
            costMicros: 0,
          })
          .onConflictDoNothing();
      }
      const outcomes = await options.database
        .select()
        .from(factoryBenchmarkOutcomes)
        .where(eq(factoryBenchmarkOutcomes.benchmarkRunId, benchmarkRunId));
      const pairOutcomes = outcomes.filter(
        (outcome) => outcome.harness === harness && outcome.model === model,
      );
      if (pairOutcomes.length === task.checks.length) {
        const successful = pairOutcomes.every((outcome) => outcome.passed)
          ? task.checks.length
          : 0;
        await options.store.benchmark({
          harness,
          model,
          task: task.kind,
          quality: successful / task.checks.length,
          successfulOutcomes: successful,
          attemptedOutcomes: task.checks.length,
          totalCostMicros: pairOutcomes.reduce(
            (total, outcome) => total + outcome.costMicros,
            0,
          ),
          enabled: true,
          source: "measured",
          benchmarkRunId,
        });
      }
      if (outcomes.length === task.pairs.length * task.checks.length)
        await options.database
          .update(factoryBenchmarkRuns)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(factoryBenchmarkRuns.id, benchmarkRunId));
      // Benchmarks have no human deliverable to approve. Their gate is the runtime checks and
      // independent reviewer above, so settle the workflow after those outcomes are durable.
      if (snapshot.run.status === "awaiting_approval")
        await options.runtime.approve(snapshot.run.id, "benchmark-runner");
      return true;
    },
  };
}

export type FactoryBenchmarkRunner = ReturnType<
  typeof createFactoryBenchmarkRunner
>;
