import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { shadowEvaluations } from "../db/schema";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const shouldShadow = (requestKey: string, rateBasisPoints = 500) => {
  if (
    !Number.isInteger(rateBasisPoints) ||
    rateBasisPoints < 0 ||
    rateBasisPoints > 10_000
  )
    throw new Error("Shadow rate must be between 0 and 10,000 basis points.");
  return (
    Number.parseInt(digest(requestKey).slice(0, 8), 16) % 10_000 <
    rateBasisPoints
  );
};

const tokens = (value: string) =>
  new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);

export const outputAgreement = (primary: string, shadow: string) => {
  const left = tokens(primary);
  const right = tokens(shadow);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 10_000;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return Math.round((intersection / union.size) * 10_000);
};

export function createShadowEvaluator(database: Database, tenantId: string) {
  return {
    shouldEvaluate(requestKey: string, rateBasisPoints = 500) {
      return shouldShadow(`${tenantId}:${requestKey}`, rateBasisPoints);
    },

    async record(input: {
      requestKey: string;
      primaryModel: string;
      shadowModel: string;
      primaryOutput: string;
      shadowOutput: string;
      shadowLatencyMs: number;
    }) {
      const [row] = await database
        .insert(shadowEvaluations)
        .values({
          tenantId,
          requestKey: input.requestKey,
          primaryModel: input.primaryModel,
          shadowModel: input.shadowModel,
          primaryOutputHash: digest(input.primaryOutput),
          shadowOutputHash: digest(input.shadowOutput),
          agreementBasisPoints: outputAgreement(
            input.primaryOutput,
            input.shadowOutput,
          ),
          shadowLatencyMs: Math.max(0, Math.round(input.shadowLatencyMs)),
          evaluatorVersion: "token-jaccard/v1",
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },

    async recordFailure(input: {
      requestKey: string;
      primaryModel: string;
      shadowModel: string;
      primaryOutput: string;
      shadowLatencyMs: number;
      error: string;
    }) {
      const [row] = await database
        .insert(shadowEvaluations)
        .values({
          tenantId,
          requestKey: input.requestKey,
          primaryModel: input.primaryModel,
          shadowModel: input.shadowModel,
          primaryOutputHash: digest(input.primaryOutput),
          shadowOutputHash: digest(""),
          agreementBasisPoints: 0,
          shadowLatencyMs: Math.max(0, Math.round(input.shadowLatencyMs)),
          evaluatorVersion: "token-jaccard/v1",
          status: "failed",
          error: input.error.slice(0, 2_000),
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },

    async dashboard() {
      const [summary] = await database
        .select({
          completed: sql<number>`count(*) filter (where ${shadowEvaluations.status} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${shadowEvaluations.status} = 'failed')::int`,
          averageAgreement: sql<number>`coalesce(round(avg(${shadowEvaluations.agreementBasisPoints}) filter (where ${shadowEvaluations.status} = 'completed')), 0)::int`,
          averageLatencyMs: sql<number>`coalesce(round(avg(${shadowEvaluations.shadowLatencyMs}) filter (where ${shadowEvaluations.status} = 'completed')), 0)::int`,
        })
        .from(shadowEvaluations)
        .where(eq(shadowEvaluations.tenantId, tenantId));
      const recent = await database
        .select()
        .from(shadowEvaluations)
        .where(eq(shadowEvaluations.tenantId, tenantId))
        .orderBy(desc(shadowEvaluations.createdAt))
        .limit(20);
      return { ...summary, recent };
    },
  };
}

export type ShadowEvaluator = ReturnType<typeof createShadowEvaluator>;
