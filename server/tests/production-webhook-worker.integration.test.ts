import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  productionIssues,
  productionMonitors,
  reconciledWebhookEvents,
} from "../src/db/schema";
import {
  createProductionEngineerRoutes,
  processProductionWebhook,
} from "../src/production-engineer/routes";
import { createProductionEngineerStore } from "../src/production-engineer/store";
import { createWebhookReconciler } from "../src/webhooks/reconciler";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tenantId = `production-webhook-${crypto.randomUUID()}`;
const monitorKey = `tool-failures-${crypto.randomUUID()}`;
const secret = "durable-alertmanager-proof";
const store = createProductionEngineerStore(database);
const reconciler = createWebhookReconciler(database, { tenantId });
let monitorId = crypto.randomUUID();

afterAll(async () => {
  await database
    .delete(productionIssues)
    .where(eq(productionIssues.monitorId, monitorId));
  await database
    .delete(productionMonitors)
    .where(eq(productionMonitors.key, monitorKey));
  await database
    .delete(reconciledWebhookEvents)
    .where(eq(reconciledWebhookEvents.tenantId, tenantId));
});

describe("signed provider ingress through the durable worker", () => {
  test("a signed Alertmanager firing survives HTTP and is processed exactly once", async () => {
    const [monitor] = await database
      .insert(productionMonitors)
      .values({
        key: monitorKey,
        title: "Durable tool failures",
        intent: "real ingress proof",
        expression: "openbot_tool_failures_total",
        threshold: 3,
        createdBy: "integration",
      })
      .returning();
    if (!monitor) throw new Error("Proof monitor was not created.");
    monitorId = monitor.id;
    const body = JSON.stringify({
      alerts: [
        {
          status: "firing",
          labels: { monitor_key: monitorKey, deployment: tenantId },
          annotations: { openbot_value: "8" },
          startsAt: "2026-09-02T12:00:00Z",
        },
      ],
    });
    const routes = createProductionEngineerRoutes(
      store,
      async (_context, next) => next(),
      { alertmanagerWebhookSecret: secret, reconciler },
    );
    const response = await routes.request("/alertmanager-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
    expect(response.status).toBe(202);
    expect((await reconciler.dashboard()).pending).toBe(1);

    const event = await reconciler.claim("worker-proof");
    expect(event?.status).toBe("pending");
    if (!event) throw new Error("Durable event was not claimable.");
    const result = await processProductionWebhook(store, event);
    expect(result).toMatchObject({ genuine: true });
    await reconciler.complete(event.id, "worker-proof");

    const persisted = await database
      .select()
      .from(productionIssues)
      .where(and(eq(productionIssues.monitorId, monitor.id)));
    expect(persisted).toHaveLength(1);
    expect((await reconciler.dashboard()).processed).toBe(1);
    expect(await reconciler.claim("worker-proof-2")).toBeUndefined();
  });
});
