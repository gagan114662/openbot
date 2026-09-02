import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
const sessionId = `killed-tab-${crypto.randomUUID()}`;

afterAll(async () => {
  await database
    .delete(analyticsEvents)
    .where(eq(analyticsEvents.sessionId, sessionId));
  await database
    .delete(analyticsSessions)
    .where(eq(analyticsSessions.id, sessionId));
});

describe("stale analytics session recovery", () => {
  test("a hard-killed client is closed exactly once across competing sweepers", async () => {
    await store.ingest("killed-tab-owner", {
      session: {
        id: sessionId,
        agentId: "general-assistant",
        source: "openbot-channel",
        status: "running",
        startedAt: "2026-09-01T16:00:00.000Z",
      },
    });
    await database
      .update(analyticsSessions)
      .set({ updatedAt: new Date("2026-09-01T16:00:01.000Z") })
      .where(eq(analyticsSessions.id, sessionId));

    const swept = await Promise.all([
      store.abandonStaleSessions(new Date("2026-09-01T16:15:00.000Z")),
      store.abandonStaleSessions(new Date("2026-09-01T16:15:00.000Z")),
    ]);
    expect(swept.reduce((sum, count) => sum + count, 0)).toBe(1);

    const [session] = await database
      .select()
      .from(analyticsSessions)
      .where(eq(analyticsSessions.id, sessionId));
    const events = await database
      .select()
      .from(analyticsEvents)
      .where(eq(analyticsEvents.sessionId, sessionId));
    expect(session).toMatchObject({
      status: "abandoned",
      technicalFailure: true,
    });
    expect(session?.endedAt).toBeInstanceOf(Date);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "openbot-session-sweeper",
      eventType: "agent.turn.abandoned",
      errorType: "terminal_event_missing",
      success: false,
    });
  });
});
