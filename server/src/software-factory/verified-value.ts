import { createHash } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { factoryWorkflowRuns, verifiedValueOutcomes } from "../db/schema";

const exactNonnegative = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer.`);
  return value;
};

const timestamp = (value: unknown, name: string) => {
  const result = new Date(String(value));
  if (Number.isNaN(result.valueOf()))
    throw new Error(`${name} must be a valid timestamp.`);
  return result;
};

export function createVerifiedValueStore(database: Database, tenantId: string) {
  return {
    async record(input: {
      workflowRunId: string;
      source: string;
      sourceEventId: string;
      evidenceRef: string;
      baselineStartedAt: unknown;
      baselineCompletedAt: unknown;
      hourlyLaborMicros: unknown;
      revenueMicros: unknown;
    }) {
      const baselineStartedAt = timestamp(
        input.baselineStartedAt,
        "Baseline start",
      );
      const baselineCompletedAt = timestamp(
        input.baselineCompletedAt,
        "Baseline completion",
      );
      if (baselineCompletedAt <= baselineStartedAt)
        throw new Error("Baseline completion must be after its start.");
      const hourlyLaborMicros = exactNonnegative(
        input.hourlyLaborMicros,
        "Hourly labor value",
      );
      const revenueMicros = exactNonnegative(input.revenueMicros, "Revenue");
      const [run] = await database
        .select()
        .from(factoryWorkflowRuns)
        .where(
          and(
            eq(factoryWorkflowRuns.id, input.workflowRunId),
            eq(factoryWorkflowRuns.tenantId, tenantId),
          ),
        );
      if (
        !run?.startedAt ||
        !run.completedAt ||
        run.status !== "succeeded" ||
        !run.approvedBy
      )
        throw new Error(
          "Only a completed, human-approved workflow can create verified value.",
        );
      const baselineMs =
        baselineCompletedAt.valueOf() - baselineStartedAt.valueOf();
      const actualMs = run.completedAt.valueOf() - run.startedAt.valueOf();
      const humanMinutesSaved = Math.max(
        0,
        Math.floor((baselineMs - actualMs) / 60_000),
      );
      const laborValueMicros = Math.floor(
        (hourlyLaborMicros * humanMinutesSaved) / 60,
      );
      const evidence = {
        workflowRunId: run.id,
        source: input.source,
        sourceEventId: input.sourceEventId,
        evidenceRef: input.evidenceRef,
        baselineStartedAt: baselineStartedAt.toISOString(),
        baselineCompletedAt: baselineCompletedAt.toISOString(),
        actualStartedAt: run.startedAt.toISOString(),
        actualCompletedAt: run.completedAt.toISOString(),
        hourlyLaborMicros,
        revenueMicros,
      };
      const [outcome] = await database
        .insert(verifiedValueOutcomes)
        .values({
          tenantId,
          workflowRunId: run.id,
          source: input.source.slice(0, 200),
          sourceEventId: input.sourceEventId.slice(0, 500),
          evidenceRef: input.evidenceRef.slice(0, 2_000),
          evidenceChecksum: createHash("sha256")
            .update(JSON.stringify(evidence))
            .digest("hex"),
          baselineStartedAt,
          baselineCompletedAt,
          actualStartedAt: run.startedAt,
          actualCompletedAt: run.completedAt,
          humanMinutesSaved,
          hourlyLaborMicros,
          laborValueMicros,
          revenueMicros,
        })
        .onConflictDoNothing()
        .returning();
      return outcome ?? null;
    },

    async dashboard() {
      const [totals] = await database
        .select({
          outcomes: sql<number>`count(*)::int`,
          humanMinutesSaved: sql<number>`coalesce(sum(${verifiedValueOutcomes.humanMinutesSaved}), 0)::float8`,
          laborValueMicros: sql<number>`coalesce(sum(${verifiedValueOutcomes.laborValueMicros}), 0)::float8`,
          revenueMicros: sql<number>`coalesce(sum(${verifiedValueOutcomes.revenueMicros}), 0)::float8`,
        })
        .from(verifiedValueOutcomes)
        .where(
          and(
            eq(verifiedValueOutcomes.tenantId, tenantId),
            gte(
              verifiedValueOutcomes.createdAt,
              sql`date_trunc('week', now())`,
            ),
          ),
        );
      const recent = await database
        .select()
        .from(verifiedValueOutcomes)
        .where(eq(verifiedValueOutcomes.tenantId, tenantId))
        .orderBy(desc(verifiedValueOutcomes.createdAt))
        .limit(20);
      return { ...totals, recent };
    },
  };
}

export type VerifiedValueStore = ReturnType<typeof createVerifiedValueStore>;
