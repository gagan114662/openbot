import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { reconciledWebhookEvents } from "../src/db/schema";
import {
  createWebhookReconciler,
  retryDelayMs,
} from "../src/webhooks/reconciler";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tenantId = `webhook-test-${crypto.randomUUID()}`;

afterAll(() =>
  database
    .delete(reconciledWebhookEvents)
    .where(eq(reconciledWebhookEvents.tenantId, tenantId)),
);

describe("idempotent webhook reconciliation", () => {
  test("deduplicates delivery and processes an aggregate strictly in sequence", async () => {
    const reconciler = createWebhookReconciler(database, { tenantId });
    const second = await reconciler.ingest({
      provider: "legacy-sql",
      eventId: "event-2",
      aggregateKey: "customer-42",
      sequence: 2,
      payload: { state: "second" },
    });
    const first = await reconciler.ingest({
      provider: "legacy-sql",
      eventId: "event-1",
      aggregateKey: "customer-42",
      sequence: 1,
      payload: { state: "first" },
    });
    const duplicate = await reconciler.ingest({
      provider: "legacy-sql",
      eventId: "event-1",
      aggregateKey: "customer-42",
      sequence: 1,
      payload: { state: "must not replace" },
    });
    expect(duplicate?.id).toBe(first?.id);
    const claimOne = await reconciler.claim("worker-a");
    expect(claimOne?.id).toBe(first?.id);
    await reconciler.complete(claimOne?.id ?? "missing", "worker-a");
    const claimTwo = await reconciler.claim("worker-b");
    expect(claimTwo?.id).toBe(second?.id);
  });

  test("uses exponential retry and moves a poison event to the dead-letter queue", async () => {
    const scopedTenant = `${tenantId}-dead`;
    const reconciler = createWebhookReconciler(database, {
      tenantId: scopedTenant,
      maximumAttempts: 2,
    });
    await reconciler.ingest({
      provider: "erp",
      eventId: "poison",
      aggregateKey: "order-9",
      sequence: 1,
      payload: { invalid: true },
    });
    const start = new Date(Date.now() + 1_000);
    const first = await reconciler.claim("worker", start);
    const retried = await reconciler.fail(
      first?.id ?? "missing",
      "worker",
      "temporary outage",
      start,
      () => 0.5,
    );
    expect(retried?.status).toBe("retrying");
    expect(retried?.availableAt.getTime() - start.getTime()).toBe(
      retryDelayMs(1, () => 0.5),
    );
    const second = await reconciler.claim(
      "worker",
      retried?.availableAt ?? start,
    );
    const dead = await reconciler.fail(
      second?.id ?? "missing",
      "worker",
      "poison payload",
      new Date(start.getTime() + 10_000),
    );
    expect(dead).toMatchObject({ status: "dead", attempts: 2 });
    expect((await reconciler.dashboard()).dead).toBe(1);
    const replayed = await reconciler.replayDead(dead?.id ?? "missing");
    expect(replayed).toMatchObject({ status: "pending", attempts: 0 });
    await database
      .delete(reconciledWebhookEvents)
      .where(eq(reconciledWebhookEvents.tenantId, scopedTenant));
  });
});
