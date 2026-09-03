import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  factoryContextEdges,
  factoryContextNodes,
  factoryManagedJobs,
  factoryModelBenchmarks,
} from "../src/db/schema";
import { createContextGraph } from "../src/software-factory/context-graph";
import { createSoftwareFactoryStore } from "../src/software-factory/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tenantId = `factory-test-${crypto.randomUUID()}`;
const graph = createContextGraph(database);
const store = createSoftwareFactoryStore(database, tenantId);

afterAll(async () => {
  await database
    .delete(factoryContextEdges)
    .where(eq(factoryContextEdges.tenantId, tenantId));
  await database
    .delete(factoryContextNodes)
    .where(eq(factoryContextNodes.tenantId, tenantId));
  await database
    .delete(factoryManagedJobs)
    .where(eq(factoryManagedJobs.tenantId, tenantId));
  await database
    .delete(factoryModelBenchmarks)
    .where(eq(factoryModelBenchmarks.tenantId, tenantId));
});

describe("persistent software factory", () => {
  test("grounds a cross-system relationship without crossing tenant boundaries", async () => {
    await graph.upsertNode(tenantId, {
      key: "repo:openbot",
      kind: "repository",
      title: "OpenBot",
      value: "fork repository",
      sourceSystem: "github",
      refreshedAt: new Date(),
    });
    await graph.upsertNode(tenantId, {
      key: "ci:run-42",
      kind: "ci-run",
      title: "CI run 42",
      value: "failed test",
      sourceSystem: "github-actions",
      refreshedAt: new Date(),
    });
    await graph.connect(tenantId, {
      fromKey: "ci:run-42",
      toKey: "repo:openbot",
      relation: "tests",
      evidence: { run: 42 },
    });
    const grounded = await graph.ground(tenantId, ["ci:run-42"]);
    expect(grounded.map((item) => item.key).sort()).toEqual([
      "ci:run-42",
      "repo:openbot",
    ]);
    expect(await graph.ground("another-tenant", ["ci:run-42"])).toEqual([]);
    expect(await graph.stats(tenantId)).toEqual({
      nodes: 2,
      edges: 1,
      sourceSystems: 2,
    });
  });

  test("persists a benchmark route and feeds verified outcome cost back exactly once", async () => {
    await store.benchmark({
      harness: "claude",
      model: "worker-small",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 9,
      attemptedOutcomes: 10,
      totalCostMicros: 900,
      enabled: true,
    });
    const queued = await store.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "repair the failed gate",
      trigger: "github-actions",
      minimumQuality: 0.8,
    });
    expect(queued.decision).toMatchObject({
      harness: "claude",
      model: "worker-small",
    });
    expect(queued.job).toMatchObject({ selectedHarness: "claude" });
    await store.completeJob(queued.job?.id ?? "missing", {
      success: true,
      costMicros: 100,
      outcome: { gate: "green" },
    });
    await store.completeJob(queued.job?.id ?? "missing", {
      success: true,
      costMicros: 100,
      outcome: { gate: "green" },
    });
    const [benchmark] = await database
      .select()
      .from(factoryModelBenchmarks)
      .where(
        and(
          eq(factoryModelBenchmarks.tenantId, tenantId),
          eq(factoryModelBenchmarks.harness, "claude"),
          eq(factoryModelBenchmarks.model, "worker-small"),
        ),
      );
    expect(benchmark).toMatchObject({
      attemptedOutcomes: 11,
      successfulOutcomes: 10,
      totalCostMicros: 1_000,
    });
  });
});
