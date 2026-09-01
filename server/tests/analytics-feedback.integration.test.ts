import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import {
  analyticsEvents,
  analyticsFeedback,
  analyticsSessions,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createAnalyticsStore(database);
const sessionId = `feedback-proof-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(analyticsEvents)
    .where(eq(analyticsEvents.sessionId, sessionId));
  await database
    .delete(analyticsFeedback)
    .where(eq(analyticsFeedback.sessionId, sessionId));
  await database
    .delete(analyticsSessions)
    .where(eq(analyticsSessions.id, sessionId));
});

describe("analytics feedback isolation", () => {
  test("updates task correctness only for the session owner", async () => {
    await store.ingest("owner-a", {
      session: {
        id: sessionId,
        source: "integration-test",
        status: "completed",
      },
      events: [
        {
          idempotencyKey: `${sessionId}:completed`,
          eventType: "agent.turn.completed",
          name: "Completed",
          properties: { toolCalls: 8, humanWaitMs: 0 },
        },
      ],
    });

    await expect(
      store.feedback("intruder-b", sessionId, { taskCompleted: false }),
    ).rejects.toThrow("another user");

    await store.feedback("owner-a", sessionId, {
      taskCompleted: true,
      rating: 5,
      negative: false,
      category: "answer_correctness",
      note: "Private explanation from owner-a@example.com",
    });

    const [session] = await database
      .select({
        taskCompleted: analyticsSessions.taskCompleted,
        negativeFeedback: analyticsSessions.negativeFeedback,
      })
      .from(analyticsSessions)
      .where(eq(analyticsSessions.id, sessionId));
    const feedback = await database
      .select({
        userId: analyticsFeedback.userId,
        note: analyticsFeedback.note,
      })
      .from(analyticsFeedback)
      .where(eq(analyticsFeedback.sessionId, sessionId));

    expect(session).toEqual({
      taskCompleted: true,
      negativeFeedback: false,
    });
    expect(feedback).toEqual([{ userId: "owner-a", note: null }]);

    const listed = await store.list({ search: sessionId, limit: 1 });
    expect(listed.sessions[0]).toMatchObject({
      id: sessionId,
      toolCalls: 8,
      humanWaitMs: 0,
    });
  });
});
