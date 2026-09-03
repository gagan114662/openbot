import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { factoryManagedJobs, factoryModelBenchmarks } from "../db/schema";
import {
  chooseModel,
  type ExecutionTier,
  type ModelBenchmark,
  recordOutcome,
} from "./model-router";
import type { ManagedJobKind } from "./orchestrator";

const benchmarkFromRow = (
  row: typeof factoryModelBenchmarks.$inferSelect,
): ModelBenchmark => ({
  harness: row.harness === "claude" ? "claude" : "codex",
  model: row.model,
  task: row.task,
  quality: row.qualityBasisPoints / 10_000,
  successfulOutcomes: row.successfulOutcomes,
  attemptedOutcomes: row.attemptedOutcomes,
  totalCostMicros: row.totalCostMicros,
  enabled: row.enabled,
  source: row.source === "measured" ? "measured" : "seeded",
  benchmarkRunId: row.benchmarkRunId,
  seedReason: row.seedReason,
});

export function createSoftwareFactoryStore(
  database: Database,
  tenantId: string,
) {
  return {
    async dashboard() {
      const [benchmarks, jobs] = await Promise.all([
        database
          .select()
          .from(factoryModelBenchmarks)
          .where(eq(factoryModelBenchmarks.tenantId, tenantId)),
        database
          .select()
          .from(factoryManagedJobs)
          .where(eq(factoryManagedJobs.tenantId, tenantId))
          .orderBy(desc(factoryManagedJobs.createdAt))
          .limit(100),
      ]);
      return { benchmarks: benchmarks.map(benchmarkFromRow), jobs };
    },

    async benchmark(input: ModelBenchmark) {
      if (
        !Number.isFinite(input.quality) ||
        input.quality < 0 ||
        input.quality > 1
      )
        throw new Error("Benchmark quality must be between zero and one.");
      await database
        .insert(factoryModelBenchmarks)
        .values({
          tenantId,
          harness: input.harness ?? "codex",
          model: input.model,
          task: input.task,
          qualityBasisPoints: Math.round(input.quality * 10_000),
          successfulOutcomes: input.successfulOutcomes,
          attemptedOutcomes: input.attemptedOutcomes,
          totalCostMicros: input.totalCostMicros,
          enabled: input.enabled,
          source: input.source ?? "seeded",
          benchmarkRunId: input.benchmarkRunId ?? null,
          seedReason:
            (input.source ?? "seeded") === "seeded"
              ? (input.seedReason ??
                "Explicit administrative seed for bootstrap")
              : null,
        })
        .onConflictDoUpdate({
          target: [
            factoryModelBenchmarks.tenantId,
            factoryModelBenchmarks.harness,
            factoryModelBenchmarks.model,
            factoryModelBenchmarks.task,
          ],
          set: {
            qualityBasisPoints: Math.round(input.quality * 10_000),
            successfulOutcomes: input.successfulOutcomes,
            attemptedOutcomes: input.attemptedOutcomes,
            totalCostMicros: input.totalCostMicros,
            enabled: input.enabled,
            source: input.source ?? "seeded",
            benchmarkRunId: input.benchmarkRunId ?? null,
            seedReason:
              (input.source ?? "seeded") === "seeded"
                ? (input.seedReason ??
                  "Explicit administrative seed for bootstrap")
                : null,
            updatedAt: new Date(),
          },
        });
    },

    async queueBenchmarkJob(input: {
      actorId: string;
      kind: ManagedJobKind;
      objective: string;
      benchmarkRunId: string;
      harness: "codex" | "claude";
      model: string;
    }) {
      const reason = `Measured benchmark run ${input.benchmarkRunId}; results are derived from runtime checks.`;
      const [job] = await database
        .insert(factoryManagedJobs)
        .values({
          tenantId,
          kind: input.kind,
          tier: "managed",
          objective: input.objective,
          trigger: "benchmark-runner",
          launchMetadata: {
            benchmarkRunId: input.benchmarkRunId,
            benchmarkPair: {
              harness: input.harness,
              model: input.model,
            },
          },
          selectedModel: input.model,
          selectedHarness: input.harness,
          routingSource: "measured",
          routingReason: reason,
          createdBy: input.actorId,
        })
        .returning();
      if (!job) throw new Error("Could not create benchmark workflow job.");
      return job;
    },

    async queueJob(
      actorId: string,
      input: {
        kind: ManagedJobKind;
        tier: ExecutionTier;
        objective: string;
        trigger: string;
        minimumQuality: number;
        launchMetadata?: Record<string, unknown>;
      },
    ) {
      const candidates = await database
        .select()
        .from(factoryModelBenchmarks)
        .where(
          and(
            eq(factoryModelBenchmarks.tenantId, tenantId),
            eq(factoryModelBenchmarks.task, input.kind),
          ),
        );
      const decision = chooseModel({
        task: input.kind,
        tier: input.tier,
        minimumQuality: input.minimumQuality,
        candidates: candidates.map(benchmarkFromRow),
        allowSeeded:
          process.env.SOFTWARE_FACTORY_ALLOW_SEEDED_ROUTES === "true",
      });
      const [job] = await database
        .insert(factoryManagedJobs)
        .values({
          tenantId,
          kind: input.kind,
          tier: input.tier,
          objective: input.objective,
          trigger: input.trigger,
          launchMetadata: input.launchMetadata ?? {},
          selectedModel: decision.model,
          selectedHarness: decision.harness,
          routingSource: decision.source,
          routingReason: decision.reason,
          createdBy: actorId,
        })
        .returning();
      return { job, decision };
    },

    async completeJob(
      jobId: string,
      input: {
        success: boolean;
        costMicros: number;
        outcome: Record<string, unknown>;
      },
    ) {
      return database.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(factoryManagedJobs)
          .where(
            and(
              eq(factoryManagedJobs.tenantId, tenantId),
              eq(factoryManagedJobs.id, jobId),
            ),
          )
          .for("update");
        if (!job?.selectedModel)
          throw new Error("Managed job or routed model was not found.");
        if (job.status === "succeeded" || job.status === "failed") return job;
        const [row] = await tx
          .select()
          .from(factoryModelBenchmarks)
          .where(
            and(
              eq(factoryModelBenchmarks.tenantId, tenantId),
              eq(
                factoryModelBenchmarks.harness,
                job.selectedHarness ?? "codex",
              ),
              eq(factoryModelBenchmarks.model, job.selectedModel),
              eq(factoryModelBenchmarks.task, job.kind),
            ),
          )
          .for("update");
        if (!row)
          throw new Error(
            "The routed benchmark disappeared before outcome recording.",
          );
        const updated = recordOutcome(benchmarkFromRow(row), input);
        await tx
          .update(factoryModelBenchmarks)
          .set({
            qualityBasisPoints: Math.round(updated.quality * 10_000),
            successfulOutcomes: updated.successfulOutcomes,
            attemptedOutcomes: updated.attemptedOutcomes,
            totalCostMicros: updated.totalCostMicros,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(factoryModelBenchmarks.tenantId, tenantId),
              eq(
                factoryModelBenchmarks.harness,
                job.selectedHarness ?? "codex",
              ),
              eq(factoryModelBenchmarks.model, job.selectedModel),
              eq(factoryModelBenchmarks.task, job.kind),
            ),
          );
        const [completed] = await tx
          .update(factoryManagedJobs)
          .set({
            status: input.success ? "succeeded" : "failed",
            costMicros: input.costMicros,
            outcome: input.outcome,
            updatedAt: new Date(),
          })
          .where(eq(factoryManagedJobs.id, jobId))
          .returning();
        return completed;
      });
    },
  };
}

export type SoftwareFactoryStore = ReturnType<
  typeof createSoftwareFactoryStore
>;
