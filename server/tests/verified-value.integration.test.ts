import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import {
  factoryManagedJobs,
  factoryModelBenchmarks,
  factoryWorkflowArtifacts,
  factoryWorkflowRuns,
  factoryWorkflowStages,
  reconciledWebhookEvents,
  verifiedValueOutcomes,
} from "../src/db/schema";
import {
  createProductionEngineerRoutes,
  processProductionWebhook,
} from "../src/production-engineer/routes";
import { createProductionEngineerStore } from "../src/production-engineer/store";
import { createSoftwareFactoryStore } from "../src/software-factory/store";
import {
  artifactChecksum,
  createWorkflowRuntime,
} from "../src/software-factory/workflow-runtime";
import { createVerifiedValueStore } from "../src/software-factory/verified-value";
import { createWebhookReconciler } from "../src/webhooks/reconciler";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tenantId = `verified-value-${crypto.randomUUID()}`;
const factory = createSoftwareFactoryStore(database, tenantId);
const runtime = createWorkflowRuntime(database, tenantId);
const values = createVerifiedValueStore(database, tenantId);
const reconciler = createWebhookReconciler(database, { tenantId });
const secret = "independent-value-source-secret";

afterAll(async () => {
  await database
    .delete(verifiedValueOutcomes)
    .where(eq(verifiedValueOutcomes.tenantId, tenantId));
  await database
    .delete(reconciledWebhookEvents)
    .where(eq(reconciledWebhookEvents.tenantId, tenantId));
  await database
    .delete(factoryWorkflowArtifacts)
    .where(eq(factoryWorkflowArtifacts.runId, runId));
  await database
    .delete(factoryWorkflowStages)
    .where(eq(factoryWorkflowStages.runId, runId));
  await database
    .delete(factoryWorkflowRuns)
    .where(eq(factoryWorkflowRuns.tenantId, tenantId));
  await database
    .delete(factoryManagedJobs)
    .where(eq(factoryManagedJobs.tenantId, tenantId));
  await database
    .delete(factoryModelBenchmarks)
    .where(eq(factoryModelBenchmarks.tenantId, tenantId));
});

let runId = crypto.randomUUID();

describe("source-proven, server-derived customer value", () => {
  test("excludes declarations and derives savings only after signed evidence and approval", async () => {
    await factory.benchmark({
      model: "worker",
      task: "ci-repair",
      quality: 0.9,
      successfulOutcomes: 1,
      attemptedOutcomes: 1,
      totalCostMicros: 10,
      enabled: true,
    });
    const queued = await factory.queueJob("admin", {
      kind: "ci-repair",
      tier: "managed",
      objective: "repair CI",
      trigger: "provider",
      minimumQuality: 0.8,
    });
    const run = await runtime.create({
      jobId: queued.job.id,
      maximumAttempts: 1,
      concurrencyLimit: 1,
      stages: [
        {
          id: "repair",
          objective: "repair CI",
          requiredContext: [],
          dependsOn: [],
        },
      ],
    });
    runId = run.id;
    await runtime.claim("worker");
    await runtime.startStage(run.id, "repair", "worker-session");
    const content = "focused checks passed";
    await runtime.completeStage(run.id, "repair", {
      summary: content,
      sessionId: "worker-session",
      reviewerSessionId: "reviewer-session",
      verification: {
        accepted: true,
        summary: "independent review passed",
        checks: ["focused test"],
      },
      artifacts: [
        {
          kind: "test-result",
          uri: `workflow://${run.id}/proof`,
          content,
          checksum: artifactChecksum(content),
          revision: "deadbeef",
          producerSessionId: "worker-session",
        },
      ],
    });
    await runtime.approve(run.id, "human-admin");

    const body = JSON.stringify({
      eventId: `source-${crypto.randomUUID()}`,
      workflowRunId: run.id,
      source: "jira-control-sample",
      evidenceRef: "jira://control/ENG-42",
      baselineStartedAt: "2026-09-01T09:00:00Z",
      baselineCompletedAt: "2026-09-01T11:00:00Z",
      hourlyLaborMicros: 60_000_000,
      revenueMicros: 25_000_000,
    });
    const routes = createProductionEngineerRoutes(
      createProductionEngineerStore(database),
      async (_context, next) => next(),
      { valueWebhookSecret: secret, reconciler },
    );
    const forged = await routes.request("/value-webhook", {
      method: "POST",
      body,
    });
    expect(forged.status).toBe(401);
    expect((await values.dashboard()).outcomes).toBe(0);
    const accepted = await routes.request("/value-webhook", {
      method: "POST",
      headers: {
        "x-openbot-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
    expect(accepted.status).toBe(202);
    const event = await reconciler.claim("value-worker");
    if (!event) throw new Error("Value event was not queued.");
    await processProductionWebhook(
      createProductionEngineerStore(database),
      event,
      values,
    );
    await reconciler.complete(event.id, "value-worker");

    const dashboard = await values.dashboard();
    expect(dashboard.outcomes).toBe(1);
    expect(dashboard.humanMinutesSaved).toBeGreaterThanOrEqual(119);
    expect(dashboard.laborValueMicros).toBeGreaterThanOrEqual(119_000_000);
    expect(dashboard.revenueMicros).toBe(25_000_000);
    const overview = await createAnalyticsStore(database, tenantId).overview();
    expect(overview.weeklyRoi.revenueMicros).toBe(25_000_000);
    expect(dashboard.recent[0]?.evidenceChecksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
