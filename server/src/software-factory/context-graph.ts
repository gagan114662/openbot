import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { factoryContextEdges, factoryContextNodes } from "../db/schema";

export type ContextNodeInput = {
  key: string;
  kind: string;
  title: string;
  value: string;
  sourceSystem: string;
  sourceUrl?: string;
  refreshedAt: Date;
};

const checksum = (node: ContextNodeInput) =>
  createHash("sha256").update(JSON.stringify(node)).digest("hex");

const bounded = (value: string, name: string, maximum: number) => {
  const result = value.trim();
  if (!result || result.length > maximum)
    throw new Error(`${name} must contain 1-${maximum} characters.`);
  return result;
};

export function createContextGraph(database: Database) {
  return {
    async upsertNode(tenantId: string, input: ContextNodeInput) {
      const node = {
        tenantId: bounded(tenantId, "Tenant id", 200),
        key: bounded(input.key, "Context key", 500),
        kind: bounded(input.kind, "Context kind", 100),
        title: bounded(input.title, "Context title", 500),
        value: bounded(input.value, "Context value", 100_000),
        sourceSystem: bounded(input.sourceSystem, "Source system", 200),
        sourceUrl: input.sourceUrl
          ? bounded(input.sourceUrl, "Source URL", 2_000)
          : null,
        refreshedAt: input.refreshedAt,
        checksum: checksum(input),
      };
      const [saved] = await database
        .insert(factoryContextNodes)
        .values(node)
        .onConflictDoUpdate({
          target: [factoryContextNodes.tenantId, factoryContextNodes.key],
          set: { ...node, updatedAt: new Date() },
        })
        .returning();
      return saved;
    },

    async connect(
      tenantId: string,
      input: {
        fromKey: string;
        toKey: string;
        relation: string;
        evidence?: unknown;
      },
    ) {
      if (input.fromKey === input.toKey)
        throw new Error("A context edge cannot point to itself.");
      const keys = [input.fromKey, input.toKey];
      const existing = await database
        .select({ key: factoryContextNodes.key })
        .from(factoryContextNodes)
        .where(
          and(
            eq(factoryContextNodes.tenantId, tenantId),
            inArray(factoryContextNodes.key, keys),
          ),
        );
      if (new Set(existing.map((item) => item.key)).size !== 2)
        throw new Error("Both context nodes must exist in this tenant.");
      await database
        .insert(factoryContextEdges)
        .values({
          tenantId,
          fromKey: bounded(input.fromKey, "From key", 500),
          toKey: bounded(input.toKey, "To key", 500),
          relation: bounded(input.relation, "Relation", 100),
          evidence:
            input.evidence &&
            typeof input.evidence === "object" &&
            !Array.isArray(input.evidence)
              ? (input.evidence as Record<string, unknown>)
              : {},
        })
        .onConflictDoNothing();
    },

    async ground(tenantId: string, keys: string[], maximum = 50) {
      const selected = [...new Set(keys)].slice(0, maximum);
      if (selected.length === 0) return [];
      const edges = await database
        .select()
        .from(factoryContextEdges)
        .where(
          and(
            eq(factoryContextEdges.tenantId, tenantId),
            or(
              inArray(factoryContextEdges.fromKey, selected),
              inArray(factoryContextEdges.toKey, selected),
            ),
          ),
        );
      const related = [
        ...new Set([
          ...selected,
          ...edges.flatMap((edge) => [edge.fromKey, edge.toKey]),
        ]),
      ].slice(0, maximum);
      return database
        .select()
        .from(factoryContextNodes)
        .where(
          and(
            eq(factoryContextNodes.tenantId, tenantId),
            inArray(factoryContextNodes.key, related),
          ),
        );
    },

    async stats(tenantId: string) {
      const [[nodes], [edges], systems] = await Promise.all([
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(factoryContextNodes)
          .where(eq(factoryContextNodes.tenantId, tenantId)),
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(factoryContextEdges)
          .where(eq(factoryContextEdges.tenantId, tenantId)),
        database
          .selectDistinct({ sourceSystem: factoryContextNodes.sourceSystem })
          .from(factoryContextNodes)
          .where(eq(factoryContextNodes.tenantId, tenantId)),
      ]);
      return {
        nodes: nodes?.count ?? 0,
        edges: edges?.count ?? 0,
        sourceSystems: systems.length,
      };
    },
  };
}

export type ContextGraph = ReturnType<typeof createContextGraph>;
