import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import { analyticsSessions } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createAnalyticsStore(database);
const marker = crypto.randomUUID();
const ids = [
  `analytics-bigint-${marker}`,
  `analytics-expired-${marker}`,
  `analytics-redaction-${marker}`,
];

afterAll(async () => {
  await database
    .delete(analyticsSessions)
    .where(inArray(analyticsSessions.id, ids));
});

describe("analytics lifecycle", () => {
  test("stores and aggregates token totals above int32", async () => {
    await store.ingest("analytics-lifecycle-owner", {
      session: {
        id: ids[0] as string,
        source: "lifecycle-proof",
        status: "completed",
        model: `bigint-model-${marker}`,
      },
      events: [
        {
          idempotencyKey: `bigint-${marker}`,
          eventType: "agent.turn.completed",
          name: "Large token proof",
          inputTokens: 2_200_000_000,
          outputTokens: 1_100_000_000,
          costMicros: 3_300_000_000,
        },
      ],
    });
    const overview = await store.overview();
    expect(
      overview.models.find((row) => row.model === `bigint-model-${marker}`),
    ).toMatchObject({ costMicros: 3_300_000_000 });
    const listed = await store.list({ search: ids[0], limit: 1 });
    expect(listed.sessions[0]).toMatchObject({
      totalTokens: 3_300_000_000,
      costMicros: 3_300_000_000,
    });
  });

  test("purges a bounded expired session and cascades its events", async () => {
    await store.ingest("analytics-lifecycle-owner", {
      session: {
        id: ids[1] as string,
        source: "lifecycle-proof",
        status: "completed",
        startedAt: "2020-01-01T00:00:00.000Z",
      },
      events: [
        {
          idempotencyKey: `expired-${marker}`,
          eventType: "agent.turn.completed",
          name: "Expired proof",
        },
      ],
    });
    expect(
      await store.purgeSessionsBefore(new Date("2021-01-01T00:00:00.000Z"), 1),
    ).toBe(1);
    const listed = await store.list({ search: ids[1], limit: 1 });
    expect(listed.sessions).toHaveLength(0);
  });

  test("redacts a customer-enriched summary before persistence", async () => {
    await store.ingest("analytics-lifecycle-owner", {
      session: {
        id: ids[2] as string,
        source: "lifecycle-proof",
        status: "completed",
        privacyMode: "customer_enriched",
        summary: "Contact customer@example.com using AKIAIOSFODNN7EXAMPLE",
      },
    });
    const [row] = await database
      .select({ summary: analyticsSessions.summary })
      .from(analyticsSessions)
      .where(eq(analyticsSessions.id, ids[2] as string));
    expect(row?.summary).toBe(
      "Contact [EMAIL_REDACTED] using [AWS_KEY_REDACTED]",
    );
  });
});
