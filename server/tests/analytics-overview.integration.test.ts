import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import { analyticsEvents, analyticsSessions } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createAnalyticsStore(database);
const proof = randomUUID();
const sessionIds = [`overview-a-${proof}`, `overview-b-${proof}`];
const model = `overview-model-${proof}`;

afterAll(async () => {
  await database
    .delete(analyticsEvents)
    .where(inArray(analyticsEvents.sessionId, sessionIds));
  await database
    .delete(analyticsSessions)
    .where(inArray(analyticsSessions.id, sessionIds));
});

describe("analytics overview aggregation", () => {
  test("counts each session once and uses its latest completed-event metrics", async () => {
    await store.ingest("overview-owner", {
      session: {
        id: sessionIds[0] as string,
        source: "overview-proof",
        status: "completed",
        model,
      },
      events: [
        {
          idempotencyKey: `${proof}:a:stale`,
          eventType: "agent.turn.completed",
          name: "Stale completion",
          latencyMs: 1_000,
          occurredAt: "2026-01-01T00:00:00.000Z",
          properties: { humanWaitMs: 0, toolCalls: 99 },
        },
        {
          idempotencyKey: `${proof}:a:latest`,
          eventType: "agent.turn.completed",
          name: "Latest completion",
          latencyMs: 1_000,
          occurredAt: "2026-01-01T00:00:01.000Z",
          properties: { humanWaitMs: 400, toolCalls: 2 },
        },
      ],
    });
    await store.ingest("overview-owner", {
      session: {
        id: sessionIds[1] as string,
        source: "overview-proof",
        status: "completed",
        model,
      },
      events: [
        {
          idempotencyKey: `${proof}:b:latest`,
          eventType: "agent.turn.completed",
          name: "Completion",
          latencyMs: 2_000,
          occurredAt: "2026-01-01T00:00:01.000Z",
          properties: { humanWaitMs: 500, toolCalls: 3 },
        },
      ],
    });

    const overview = await store.overview();
    expect(overview.models.find((row) => row.model === model)).toMatchObject({
      sessions: 2,
      avgLatencyMs: 1_500,
      avgActiveLatencyMs: 1_050,
    });

    const listed = await store.list({ search: sessionIds[0], limit: 1 });
    expect(listed.sessions[0]).toMatchObject({
      humanWaitMs: 400,
      toolCalls: 2,
      activeLatencyMs: 600,
    });
  });
});
