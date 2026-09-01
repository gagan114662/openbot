import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import {
  analyticsEvents,
  analyticsSessions,
  auditEvents,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createAnalyticsStore(database);
const suffix = randomUUID();
const sessionId = `handoff-proof-${suffix}`;
const auditId = randomUUID();
const refusedSessionId = `handoff-refusal-proof-${suffix}`;
const refusedAuditId = randomUUID();
const threadId = "thread-handoff-verification";

afterAll(async () => {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('openbot.audit_retention_days', '1', true)`,
    );
    await tx.delete(auditEvents).where(eq(auditEvents.id, auditId));
    await tx.delete(auditEvents).where(eq(auditEvents.id, refusedAuditId));
  });
  await database
    .delete(analyticsEvents)
    .where(eq(analyticsEvents.sessionId, sessionId));
  await database
    .delete(analyticsSessions)
    .where(eq(analyticsSessions.id, sessionId));
  await database
    .delete(analyticsEvents)
    .where(eq(analyticsEvents.sessionId, refusedSessionId));
  await database
    .delete(analyticsSessions)
    .where(eq(analyticsSessions.id, refusedSessionId));
});

describe("analytics handoff verification", () => {
  test("proves an observed message_bot call from its delivered audit row", async () => {
    // Old enough that cleanup can use the real retention path; the audit table is append-only.
    const startedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000 - 20_000);
    const endedAt = new Date(startedAt.getTime() + 10_000);
    await store.ingest("owner-a", {
      session: {
        id: sessionId,
        source: "integration-test",
        agentId: "general-assistant",
        status: "completed",
        properties: { threadId },
        startedAt,
        endedAt,
      },
      events: [
        {
          idempotencyKey: `${sessionId}:tool`,
          eventType: "agent.tool.observed",
          name: "message_bot",
          occurredAt: endedAt,
        },
      ],
    });
    await database.insert(auditEvents).values({
      id: auditId,
      actorUserId: "owner-a",
      eventType: "agent.handoff_delivered",
      targetType: "agent",
      targetId: "knowledge",
      payload: {
        bot: "general-assistant",
        from: "general-assistant",
        to: "knowledge",
        run: `run-${suffix}`,
        threadId,
        depth: 1,
        ms: 1200,
      },
      // Delivery is asynchronous and may complete after the parent turn.
      createdAt: new Date(endedAt.getTime() + 2_000),
    });

    await expect(
      store.verifyToolEvidence("owner-a", sessionId),
    ).resolves.toMatchObject({
      status: "verified",
      passed: true,
      observed: ["bot/message_bot"],
      matched: ["bot/message_bot"],
      auditEventIds: [auditId],
    });
  });

  test("proves a refused message_bot call as control behavior, not tool failure", async () => {
    const startedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000 - 20_000);
    const endedAt = new Date(startedAt.getTime() + 10_000);
    await store.ingest("owner-a", {
      session: {
        id: refusedSessionId,
        source: "integration-test",
        agentId: "general-assistant",
        status: "completed",
        properties: { threadId },
        startedAt,
        endedAt,
      },
      events: [
        {
          idempotencyKey: `${refusedSessionId}:tool`,
          eventType: "agent.tool.observed",
          name: "message_bot",
          occurredAt: endedAt,
        },
      ],
    });
    await database.insert(auditEvents).values({
      id: refusedAuditId,
      actorUserId: "owner-a",
      eventType: "agent.handoff_refused",
      targetType: "agent",
      targetId: "general-assistant",
      payload: {
        bot: "general-assistant",
        from: "general-assistant",
        target: "Risk Analyst",
        run: `run-refused-${suffix}`,
        threadId,
        depth: 0,
        reason: "not_granted",
      },
      createdAt: new Date(endedAt.getTime() - 2_000),
    });

    await expect(
      store.verifyToolEvidence("owner-a", refusedSessionId),
    ).resolves.toMatchObject({
      status: "verified",
      passed: true,
      observed: ["bot/message_bot"],
      matched: ["bot/message_bot"],
      rejected: ["bot/message_bot"],
      operationalFailures: [],
      auditEventIds: [refusedAuditId],
    });
  });
});
