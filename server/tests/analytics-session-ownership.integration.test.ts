import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAnalyticsStore } from "../src/analytics/store";
import { createDatabase } from "../src/db/client";
import { analyticsSessions, auditEvents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createAnalyticsStore(database);
const sessionId = `ownership-${crypto.randomUUID()}`;

afterAll(async () => {
  await database
    .delete(analyticsSessions)
    .where(eq(analyticsSessions.id, sessionId));
});

test("a user cannot overwrite another user or agent through a chosen session id", async () => {
  await store.ingest("owner-a", {
    session: {
      id: sessionId,
      source: "ownership-proof",
      status: "completed",
      agentId: "agent-a",
      model: "original-model",
    },
  });
  await expect(
    store.ingest("owner-b", {
      session: {
        id: sessionId,
        source: "ownership-proof",
        status: "failed",
        agentId: "agent-b",
        model: "spoofed-model",
      },
    }),
  ).rejects.toThrow("belongs to another user or agent");
  const [session] = await database
    .select()
    .from(analyticsSessions)
    .where(eq(analyticsSessions.id, sessionId));
  expect(session).toMatchObject({
    userId: "owner-a",
    agentId: "agent-a",
    status: "completed",
    model: "original-model",
  });
  const [audit] = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, sessionId));
  expect(audit).toMatchObject({
    actorUserId: "owner-b",
    eventType: "analytics.session_ownership_refused",
  });
});
