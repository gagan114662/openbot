import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAnalyticsRoutes } from "../src/analytics/routes";
import type { AnalyticsStore } from "../src/analytics/store";
import type { AppVariables } from "../src/auth/guards";

function testApp(
  role: "admin" | "user",
  overrides: Partial<AnalyticsStore> = {},
  canUseBot: (botId: string) => boolean = () => true,
) {
  const calls: unknown[] = [];
  const ingest = async (actor: string, body: unknown) => {
    calls.push({ actor, body });
    return { sessionId: "session-1", acceptedEvents: 1, acceptedSpans: 0 };
  };
  const store = {
    ingest,
    ingestClient: ingest,
    list: async () => ({ sessions: [] }),
    detail: async () => null,
    overview: async () => ({ totals: { sessions: 0 }, models: [] }),
    verifyToolEvidence: async () => ({
      status: "verified",
      passed: true,
      observed: ["open-web/fetch_web_page"],
      matched: ["open-web/fetch_web_page"],
      unmatched: [],
      auditEventIds: ["audit-1"],
    }),
    verifyEscalationEvidence: async () => ({
      status: "not_applicable" as const,
    }),
    feedback: async () => ({ id: "feedback-1" }),
    evaluation: async () => ({
      status: "completed" as const,
      taskCompleted: null,
    }),
    ...overrides,
  } as AnalyticsStore;
  const app = new Hono<{ Variables: AppVariables }>();
  const authenticate = async (
    context: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    context.set("actor", { id: "person-1", email: "person@example.com", role });
    await next();
  };
  app.route(
    "/api/analytics",
    createAnalyticsRoutes(store, authenticate, async (_actor, botId) =>
      canUseBot(botId),
    ),
  );
  return { app, calls };
}

describe("agent analytics routes", () => {
  test("passes bounded pagination through the admin session endpoint", async () => {
    let query: unknown;
    const { app } = testApp("admin", {
      list: async (received) => {
        query = received;
        return { sessions: [] };
      },
    });

    const response = await app.request(
      "http://openbot.test/api/analytics/admin/sessions?search=handoff&limit=25&offset=50",
    );

    expect(response.status).toBe(200);
    expect(query).toMatchObject({ search: "handoff", limit: 25, offset: 50 });
  });

  test("attributes ingestion to the signed-in actor, not a supplied user id", async () => {
    const { app, calls } = testApp("user");
    const response = await app.request(
      "http://openbot.test/api/analytics/ingest",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: { id: "session-1", source: "openbot", userId: "attacker" },
          events: [
            {
              idempotencyKey: "event-1",
              eventType: "prompt.received",
              name: "Prompt",
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(calls[0]).toMatchObject({ actor: "person-1" });
  });

  test("rejects metrics attributed to a Bot the signed-in person cannot use", async () => {
    const { app, calls } = testApp(
      "user",
      {},
      (botId) => botId !== "private-finance-bot",
    );
    const response = await app.request(
      "http://openbot.test/api/analytics/ingest",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: {
            id: "spoofed-session",
            source: "openbot",
            agentId: "private-finance-bot",
            status: "completed",
            taskCompleted: true,
          },
        }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "That analytics agent is not available.",
    });
    expect(calls).toHaveLength(0);
  });

  test("rejects a non-admin spoof over an HTTP socket", async () => {
    const { app, calls } = testApp(
      "user",
      {},
      (botId) => botId !== "another-users-bot",
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/analytics/ingest`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: {
              id: "network-spoof",
              source: "openbot",
              agentId: "another-users-bot",
              status: "completed",
            },
          }),
        },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "That analytics agent is not available.",
      });
      expect(calls).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("restores only the signed-in person's evaluation state", async () => {
    const calls: unknown[] = [];
    const { app } = testApp("user", {
      evaluation: async (actor, sessionId) => {
        calls.push({ actor, sessionId });
        return { status: "completed", taskCompleted: true };
      },
    });
    const response = await app.request(
      "http://openbot.test/api/analytics/sessions/session-1/evaluation",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      evaluation: { status: "completed", taskCompleted: true },
    });
    expect(calls).toEqual([{ actor: "person-1", sessionId: "session-1" }]);
  });

  test("keeps analytics exploration administrator-only", async () => {
    const { app } = testApp("user");
    const response = await app.request(
      "http://openbot.test/api/analytics/admin/overview",
    );
    expect(response.status).toBe(403);
  });

  test("serves overview to an administrator", async () => {
    const { app } = testApp("admin");
    const response = await app.request(
      "http://openbot.test/api/analytics/admin/overview",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      totals: { sessions: 0 },
      models: [],
    });
  });

  test("verifies a session only as the signed-in actor", async () => {
    const calls: unknown[] = [];
    const { app } = testApp("user", {
      verifyToolEvidence: async (actor, sessionId) => {
        calls.push({ actor, sessionId });
        return { status: "not_applicable", observed: 0 };
      },
    });
    const response = await app.request(
      "http://openbot.test/api/analytics/sessions/session-1/verify-tools",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ actor: "person-1", sessionId: "session-1" }]);
  });

  test("waits for asynchronous handoff evidence instead of recording a race as failure", async () => {
    let attempts = 0;
    const { app } = testApp("user", {
      verifyToolEvidence: async () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: "pending",
              reason: "The delegated Bot has not finished delivery yet.",
              passed: false,
              observed: ["bot/message_bot"],
              matched: [],
              unmatched: ["bot/message_bot"],
              operationalFailures: [],
              rejected: [],
              auditEventIds: [],
            }
          : {
              status: "verified",
              passed: true,
              observed: ["bot/message_bot"],
              matched: ["bot/message_bot"],
              unmatched: [],
              operationalFailures: [],
              rejected: [],
              auditEventIds: ["handoff-delivered"],
            };
      },
    });

    const response = await app.request(
      "http://openbot.test/api/analytics/sessions/session-1/verify-tools",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).verification.status).toBe("verified");
    expect(attempts).toBe(2);
  });

  test("verifies human escalation as the signed-in actor", async () => {
    const calls: unknown[] = [];
    const { app } = testApp("user", {
      verifyEscalationEvidence: async (actor, sessionId) => {
        calls.push({ actor, sessionId });
        return { status: "reached", auditEventId: "audit-escalation-1" };
      },
    });
    const response = await app.request(
      "http://openbot.test/api/analytics/sessions/session-1/verify-escalation",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ actor: "person-1", sessionId: "session-1" }]);
  });

  test("records an explicit task verdict as the signed-in actor", async () => {
    const calls: unknown[] = [];
    const { app } = testApp("user", {
      feedback: async (actor, sessionId, input) => {
        calls.push({ actor, sessionId, input });
        return { id: "feedback-1" } as never;
      },
    });
    const response = await app.request(
      "http://openbot.test/api/analytics/sessions/session-1/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskCompleted: true, rating: 5 }),
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        actor: "person-1",
        sessionId: "session-1",
        input: {
          taskCompleted: true,
          rating: 5,
          negative: false,
          category: undefined,
          note: undefined,
        },
      },
    ]);
  });

  test("rejects non-boolean task verdicts", async () => {
    const { app } = testApp("user");
    const response = await app.request(
      "http://openbot.test/api/analytics/sessions/session-1/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskCompleted: "yes" }),
      },
    );
    expect(response.status).toBe(400);
  });

  test("rejects unknown privacy modes and span kinds before storage", async () => {
    const { app, calls } = testApp("user");
    const response = await app.request(
      "http://openbot.test/api/analytics/ingest",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: {
            id: "session-1",
            source: "openbot",
            privacyMode: "store_everything",
          },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
