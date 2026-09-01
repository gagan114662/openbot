import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { AnalyticsIngest, AnalyticsStore } from "./store";

const PRIVACY_MODES = new Set(["full", "metadata_only", "customer_enriched"]);
const SESSION_STATUSES = new Set([
  "running",
  "completed",
  "failed",
  "abandoned",
]);
const SPAN_KINDS = new Set(["agent", "llm", "tool", "retrieval", "product"]);

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function queryOf(url: URL) {
  const boolean = (key: string) =>
    url.searchParams.get(key) === null
      ? undefined
      : url.searchParams.get(key) === "true";
  const date = (key: string) => {
    const parsed = new Date(url.searchParams.get(key) ?? "");
    return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
  };
  const status = boundedText(url.searchParams.get("status"), 50);
  return {
    search: boundedText(url.searchParams.get("search"), 500),
    agentId: boundedText(url.searchParams.get("agentId"), 200),
    model: boundedText(url.searchParams.get("model"), 200),
    status: status && SESSION_STATUSES.has(status) ? status : undefined,
    taskCompleted: boolean("taskCompleted"),
    technicalFailure: boolean("technicalFailure"),
    toolFailure: boolean("toolFailure"),
    from: date("from"),
    to: date("to"),
    limit: Number.parseInt(url.searchParams.get("limit") ?? "50", 10),
  };
}

export function createAnalyticsRoutes(
  store: AnalyticsStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/ingest", requireUser, async (context) => {
    const body = (await context.req
      .json()
      .catch(() => null)) as AnalyticsIngest | null;
    if (
      !body?.session ||
      !boundedText(body.session.id, 500) ||
      !boundedText(body.session.source, 200)
    ) {
      return context.json(
        { error: "A session id and source are required." },
        400,
      );
    }
    if (
      body.events?.some(
        (event) =>
          !boundedText(event.idempotencyKey, 500) ||
          !boundedText(event.eventType, 200) ||
          !boundedText(event.name, 500),
      )
    ) {
      return context.json(
        { error: "Every event needs an idempotency key, type, and name." },
        400,
      );
    }
    if (
      body.spans?.some(
        (span) =>
          !boundedText(span.id, 500) ||
          !boundedText(span.traceId, 500) ||
          !boundedText(span.name, 500),
      )
    ) {
      return context.json(
        { error: "Every span needs an id, trace id, and name." },
        400,
      );
    }
    if (
      (body.session.privacyMode &&
        !PRIVACY_MODES.has(body.session.privacyMode)) ||
      (body.session.status && !SESSION_STATUSES.has(body.session.status)) ||
      body.spans?.some((span) => !SPAN_KINDS.has(span.kind))
    ) {
      return context.json(
        { error: "The privacy mode, session status, or span kind is invalid." },
        400,
      );
    }
    try {
      return context.json(await store.ingest(context.var.actor.id, body), 202);
    } catch (error) {
      if (error instanceof Error && error.message.includes("another user")) {
        return context.json(
          { error: "That analytics session is not available." },
          404,
        );
      }
      throw error;
    }
  });

  routes.post("/sessions/:sessionId/feedback", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      rating?: unknown;
      negative?: unknown;
      taskCompleted?: unknown;
      category?: unknown;
      note?: unknown;
    } | null;
    if (
      body?.rating !== undefined &&
      (!Number.isInteger(body.rating) ||
        Number(body.rating) < 1 ||
        Number(body.rating) > 5)
    ) {
      return context.json(
        { error: "Rating must be an integer from 1 to 5." },
        400,
      );
    }
    if (
      body?.taskCompleted !== undefined &&
      typeof body.taskCompleted !== "boolean"
    ) {
      return context.json({ error: "Task completed must be a boolean." }, 400);
    }
    try {
      return context.json({
        feedback: await store.feedback(
          context.var.actor.id,
          context.req.param("sessionId"),
          {
            ...(typeof body?.rating === "number"
              ? { rating: body.rating }
              : {}),
            negative: body?.negative === true,
            ...(typeof body?.taskCompleted === "boolean"
              ? { taskCompleted: body.taskCompleted }
              : {}),
            category: boundedText(body?.category, 200),
            note: boundedText(body?.note, 10_000),
          },
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("another user")) {
        return context.json(
          { error: "That analytics session is not available." },
          404,
        );
      }
      throw error;
    }
  });

  routes.get(
    "/sessions/:sessionId/evaluation",
    requireUser,
    async (context) => {
      const evaluation = await store.evaluation(
        context.var.actor.id,
        context.req.param("sessionId"),
      );
      return evaluation
        ? context.json({ evaluation })
        : context.json({ error: "Analytics session not found." }, 404);
    },
  );

  routes.post(
    "/sessions/:sessionId/verify-tools",
    requireUser,
    async (context) => {
      let verification = await store.verifyToolEvidence(
        context.var.actor.id,
        context.req.param("sessionId"),
      );
      // A handoff is queued in the parent turn and delivered by a worker. Wait for authoritative
      // delivery rather than racing it and permanently recording a false tool failure.
      for (
        let attempt = 0;
        verification?.status === "pending" && attempt < 30;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        verification = await store.verifyToolEvidence(
          context.var.actor.id,
          context.req.param("sessionId"),
        );
      }
      return verification
        ? context.json({ verification })
        : context.json({ error: "Analytics session not found." }, 404);
    },
  );

  routes.post(
    "/sessions/:sessionId/verify-escalation",
    requireUser,
    async (context) => {
      const verification = await store.verifyEscalationEvidence(
        context.var.actor.id,
        context.req.param("sessionId"),
      );
      return verification
        ? context.json({ verification })
        : context.json({ error: "Analytics session not found." }, 404);
    },
  );

  routes.use("/admin/*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.get("/admin/overview", async (context) =>
    context.json(await store.overview()),
  );
  routes.get("/admin/sessions", async (context) =>
    context.json(await store.list(queryOf(new URL(context.req.url)))),
  );
  routes.get("/admin/sessions/:sessionId", async (context) => {
    const detail = await store.detail(context.req.param("sessionId"));
    return detail
      ? context.json(detail)
      : context.json({ error: "Session not found." }, 404);
  });
  routes.get("/admin/export", async (context) => {
    const sessions = await store.list({
      ...queryOf(new URL(context.req.url)),
      limit: 200,
    });
    const details = await Promise.all(
      sessions.sessions.map((session) => store.detail(session.id)),
    );
    return new Response(
      details
        .filter(Boolean)
        .map((detail) => JSON.stringify(detail))
        .join("\n"),
      {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition":
            'attachment; filename="openbot-agent-analytics.jsonl"',
        },
      },
    );
  });

  return routes;
}
