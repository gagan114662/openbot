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
const createdIds = [sessionId];

afterAll(async () => {
  for (const id of createdIds)
    await database
      .delete(analyticsSessions)
      .where(eq(analyticsSessions.id, id));
});

test("browser ingestion replaces a client id with a stable unguessable server id", async () => {
  process.env.ANALYTICS_SESSION_HMAC_KEY =
    "test-only-session-key-with-at-least-32-bytes";
  const clientId = `client-${crypto.randomUUID()}`;
  const input = {
    session: {
      id: clientId,
      source: "ownership-proof",
      status: "running" as const,
    },
  };
  const first = await store.ingestClient("owner-a", input);
  const retry = await store.ingestClient("owner-a", input);
  createdIds.push(first.sessionId);
  expect(first.sessionId).not.toBe(clientId);
  expect(first.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(retry.sessionId).toBe(first.sessionId);
  delete process.env.ANALYTICS_SESSION_HMAC_KEY;
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
