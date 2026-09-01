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
const pausedId = `escalation-paused-${suffix}`;
const resumedId = `escalation-resumed-${suffix}`;
const auditId = randomUUID();
const threadId = "thread-escalation-wait-proof";

afterAll(async () => {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('openbot.audit_retention_days', '1', true)`,
    );
    await tx.delete(auditEvents).where(eq(auditEvents.id, auditId));
  });
  for (const id of [pausedId, resumedId]) {
    await database
      .delete(analyticsEvents)
      .where(eq(analyticsEvents.sessionId, id));
    await database
      .delete(analyticsSessions)
      .where(eq(analyticsSessions.id, id));
  }
});

describe("cross-turn human escalation wait", () => {
  test("adds the pause to total latency while preserving active latency", async () => {
    const startedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000 - 60_000);
    const endedAt = new Date(startedAt.getTime() + 5_000);
    const resumedAt = new Date(endedAt.getTime() + 30_000);
    await store.ingest("owner-a", {
      session: {
        id: pausedId,
        source: "integration-test",
        agentId: "general-assistant",
        status: "completed",
        properties: { threadId },
        startedAt,
        endedAt,
      },
      events: [
        {
          idempotencyKey: `${pausedId}:completed`,
          eventType: "agent.turn.completed",
          name: "Completed",
          latencyMs: 5_000,
          properties: { humanWaitMs: 0, toolCalls: 1 },
          occurredAt: endedAt,
        },
        {
          idempotencyKey: `${pausedId}:human-gate`,
          eventType: "agent.human_intervention.requested",
          name: "Human decision requested",
          occurredAt: endedAt,
        },
      ],
    });
    await database.insert(auditEvents).values({
      id: auditId,
      actorUserId: "owner-a",
      eventType: "agent.escalated",
      targetType: "agent",
      targetId: "general-assistant",
      payload: {
        bot: "general-assistant",
        run: `run-${suffix}`,
        threadId,
        question: "Which risk preference?",
        reached: "the person in this conversation",
      },
      createdAt: new Date(endedAt.getTime() - 1_000),
    });

    await store.ingest("owner-a", {
      session: {
        id: resumedId,
        source: "integration-test",
        agentId: "general-assistant",
        status: "running",
        properties: { threadId },
        startedAt: resumedAt,
      },
    });

    const listed = await store.list({ search: pausedId, limit: 1 });
    expect(listed.sessions[0]).toMatchObject({
      id: pausedId,
      latencyMs: 35_000,
      humanWaitMs: 30_000,
      activeLatencyMs: 5_000,
      humanIntervention: true,
    });
    const detail = await store.detail(pausedId);
    expect(
      detail?.events.find(
        (event) => event.eventType === "agent.human_intervention.resolved",
      ),
    ).toMatchObject({
      latencyMs: 30_000,
      properties: { resumedBySessionId: resumedId, threadId },
    });
  });
});
