import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  analyticsEvents,
  analyticsFeedback,
  analyticsSessions,
  analyticsSpans,
  auditEvents,
} from "../db/schema";
import {
  type AnalyticsPrivacyMode,
  contentForPrivacyMode,
  redactAnalyticsProperties,
} from "./privacy";
import { toolRefFromModelName, verifyToolExecution } from "./tool-verifier";

export type AnalyticsIngest = {
  session: {
    id: string;
    agentId?: string;
    source: string;
    privacyMode?: AnalyticsPrivacyMode;
    status?: "running" | "completed" | "failed" | "abandoned";
    intent?: string;
    summary?: string;
    replayId?: string;
    replayUrl?: string;
    model?: string;
    promptVersion?: string;
    experimentKey?: string;
    experimentVariant?: string;
    taskCompleted?: boolean;
    technicalFailure?: boolean;
    toolFailure?: boolean;
    properties?: Record<string, unknown>;
    startedAt?: string;
    endedAt?: string;
  };
  events?: Array<{
    idempotencyKey: string;
    eventType: string;
    name: string;
    content?: string;
    model?: string;
    promptVersion?: string;
    replayId?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
    success?: boolean;
    errorType?: string;
    properties?: Record<string, unknown>;
    occurredAt?: string;
  }>;
  spans?: Array<{
    id: string;
    parentSpanId?: string;
    traceId: string;
    kind: "agent" | "llm" | "tool" | "retrieval" | "product";
    name: string;
    status: string;
    input?: string;
    output?: string;
    model?: string;
    toolName?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
    attributes?: Record<string, unknown>;
    startedAt: string;
    endedAt?: string;
  }>;
};

export type AnalyticsQuery = {
  search?: string;
  agentId?: string;
  model?: string;
  status?: string;
  taskCompleted?: boolean;
  technicalFailure?: boolean;
  toolFailure?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
};

export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>;

function date(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

export function createAnalyticsStore(database: Database) {
  return {
    async ingest(actorUserId: string, input: AnalyticsIngest) {
      const mode = input.session.privacyMode ?? "metadata_only";
      const now = new Date();
      const startedAt = date(input.session.startedAt) ?? now;
      const endedAt = date(input.session.endedAt);
      const events = (input.events ?? []).slice(0, 1_000);
      const spans = (input.spans ?? []).slice(0, 1_000);

      return database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ userId: analyticsSessions.userId })
          .from(analyticsSessions)
          .where(eq(analyticsSessions.id, input.session.id))
          .limit(1);
        if (existing && existing.userId !== actorUserId) {
          throw new Error("Analytics session belongs to another user.");
        }
        await tx
          .insert(analyticsSessions)
          .values({
            id: input.session.id,
            userId: actorUserId,
            agentId: input.session.agentId,
            source: input.session.source,
            privacyMode: mode,
            status: input.session.status ?? "running",
            intent: input.session.intent?.slice(0, 500),
            summary:
              mode === "customer_enriched"
                ? input.session.summary?.slice(0, 10_000)
                : contentForPrivacyMode(input.session.summary, mode),
            replayId: input.session.replayId?.slice(0, 500),
            replayUrl: input.session.replayUrl?.slice(0, 2_000),
            model: input.session.model?.slice(0, 200),
            promptVersion: input.session.promptVersion?.slice(0, 200),
            experimentKey: input.session.experimentKey?.slice(0, 200),
            experimentVariant: input.session.experimentVariant?.slice(0, 200),
            taskCompleted: input.session.taskCompleted,
            technicalFailure: input.session.technicalFailure ?? false,
            toolFailure: input.session.toolFailure ?? false,
            properties: redactAnalyticsProperties(input.session.properties),
            startedAt,
            endedAt,
          })
          .onConflictDoUpdate({
            target: analyticsSessions.id,
            set: {
              status: input.session.status ?? "running",
              taskCompleted: input.session.taskCompleted,
              technicalFailure: input.session.technicalFailure ?? false,
              toolFailure: input.session.toolFailure ?? false,
              model: input.session.model?.slice(0, 200),
              endedAt,
              updatedAt: now,
            },
          });

        /*
         * A person answering `ask_person` starts a new turn. Close the pause on the previous turn
         * here, at the first authoritative sign that the person returned, rather than when the tool
         * immediately reports that its question was delivered. The signed audit row ties the pause
         * to this actor, Bot and thread; the event idempotency key prevents later turns from moving
         * the same answer boundary.
         */
        const threadId =
          typeof input.session.properties?.threadId === "string"
            ? input.session.properties.threadId
            : "";
        if (
          !existing &&
          threadId &&
          input.session.agentId &&
          (input.session.status ?? "running") === "running"
        ) {
          const [escalated] = await tx
            .select({ createdAt: auditEvents.createdAt })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.eventType, "agent.escalated"),
                eq(auditEvents.actorUserId, actorUserId),
                eq(auditEvents.targetId, input.session.agentId),
                lte(auditEvents.createdAt, startedAt),
                sql`${auditEvents.payload}->>'threadId' = ${threadId}`,
              ),
            )
            .orderBy(desc(auditEvents.createdAt))
            .limit(1);
          if (escalated) {
            const [paused] = await tx
              .select({
                id: analyticsSessions.id,
                endedAt: analyticsSessions.endedAt,
              })
              .from(analyticsSessions)
              .where(
                and(
                  eq(analyticsSessions.userId, actorUserId),
                  eq(analyticsSessions.agentId, input.session.agentId),
                  lte(analyticsSessions.startedAt, escalated.createdAt),
                  gte(analyticsSessions.endedAt, escalated.createdAt),
                  sql`${analyticsSessions.properties}->>'threadId' = ${threadId}`,
                ),
              )
              .orderBy(desc(analyticsSessions.startedAt))
              .limit(1);
            if (paused?.endedAt) {
              const waitMs = Math.max(
                0,
                startedAt.getTime() - paused.endedAt.getTime(),
              );
              await tx
                .insert(analyticsEvents)
                .values({
                  sessionId: paused.id,
                  source: "openbot-verifier",
                  idempotencyKey: `${paused.id}:human-resumed:v1`,
                  eventType: "agent.human_intervention.resolved",
                  name: "Human decision received",
                  userId: actorUserId,
                  agentId: input.session.agentId,
                  latencyMs: waitMs,
                  success: true,
                  properties: {
                    resumedBySessionId: input.session.id,
                    threadId,
                  },
                  occurredAt: startedAt,
                })
                .onConflictDoNothing();
            }
          }
        }

        let acceptedEvents = 0;
        const acceptedEventValues: typeof events = [];
        for (const event of events) {
          const inserted = await tx
            .insert(analyticsEvents)
            .values({
              sessionId: input.session.id,
              source: input.session.source,
              idempotencyKey: event.idempotencyKey,
              eventType: event.eventType.slice(0, 200),
              name: event.name.slice(0, 500),
              content: contentForPrivacyMode(event.content, mode),
              userId: actorUserId,
              agentId: input.session.agentId,
              model: event.model?.slice(0, 200),
              promptVersion: event.promptVersion?.slice(0, 200),
              replayId: event.replayId?.slice(0, 500),
              latencyMs: event.latencyMs,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costMicros: event.costMicros,
              success: event.success,
              errorType: event.errorType?.slice(0, 200),
              properties: redactAnalyticsProperties(event.properties),
              occurredAt: date(event.occurredAt) ?? now,
            })
            .onConflictDoNothing()
            .returning({ id: analyticsEvents.id });
          acceptedEvents += inserted.length;
          if (inserted.length) acceptedEventValues.push(event);
        }

        let acceptedSpans = 0;
        for (const span of spans) {
          const inserted = await tx
            .insert(analyticsSpans)
            .values({
              id: span.id,
              sessionId: input.session.id,
              parentSpanId: span.parentSpanId,
              traceId: span.traceId,
              kind: span.kind,
              name: span.name.slice(0, 500),
              status: span.status.slice(0, 100),
              input: contentForPrivacyMode(span.input, mode),
              output: contentForPrivacyMode(span.output, mode),
              model: span.model?.slice(0, 200),
              toolName: span.toolName?.slice(0, 500),
              latencyMs: span.latencyMs,
              inputTokens: span.inputTokens,
              outputTokens: span.outputTokens,
              costMicros: span.costMicros,
              attributes: redactAnalyticsProperties(span.attributes),
              startedAt: date(span.startedAt) ?? now,
              endedAt: date(span.endedAt),
            })
            .onConflictDoNothing()
            .returning({ id: analyticsSpans.id });
          acceptedSpans += inserted.length;
        }

        const totals = acceptedEventValues.reduce(
          (sum, event) => ({
            tokens:
              sum.tokens + (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
            cost: sum.cost + (event.costMicros ?? 0),
            latency: Math.max(sum.latency, event.latencyMs ?? 0),
          }),
          { tokens: 0, cost: 0, latency: 0 },
        );
        await tx
          .update(analyticsSessions)
          .set({
            totalTokens: sql`${analyticsSessions.totalTokens} + ${totals.tokens}`,
            costMicros: sql`${analyticsSessions.costMicros} + ${totals.cost}`,
            ...(totals.latency ? { latencyMs: totals.latency } : {}),
            updatedAt: now,
          })
          .where(eq(analyticsSessions.id, input.session.id));

        return { sessionId: input.session.id, acceptedEvents, acceptedSpans };
      });
    },

    async list(query: AnalyticsQuery) {
      const conditions = [
        query.agentId
          ? eq(analyticsSessions.agentId, query.agentId)
          : undefined,
        query.model ? eq(analyticsSessions.model, query.model) : undefined,
        query.status
          ? eq(
              analyticsSessions.status,
              query.status as "running" | "completed" | "failed" | "abandoned",
            )
          : undefined,
        query.taskCompleted === undefined
          ? undefined
          : eq(analyticsSessions.taskCompleted, query.taskCompleted),
        query.technicalFailure === undefined
          ? undefined
          : eq(analyticsSessions.technicalFailure, query.technicalFailure),
        query.toolFailure === undefined
          ? undefined
          : eq(analyticsSessions.toolFailure, query.toolFailure),
        query.from ? gte(analyticsSessions.startedAt, query.from) : undefined,
        query.to ? lte(analyticsSessions.startedAt, query.to) : undefined,
        query.search
          ? or(
              ilike(analyticsSessions.intent, `%${query.search}%`),
              ilike(analyticsSessions.summary, `%${query.search}%`),
              ilike(analyticsSessions.id, `%${query.search}%`),
            )
          : undefined,
      ].filter((item) => item !== undefined);
      const rows = await database
        .select()
        .from(analyticsSessions)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(analyticsSessions.startedAt))
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
      const verificationRows = rows.length
        ? await database
            .select({
              sessionId: analyticsEvents.sessionId,
              success: analyticsEvents.success,
            })
            .from(analyticsEvents)
            .where(
              and(
                inArray(
                  analyticsEvents.sessionId,
                  rows.map((row) => row.id),
                ),
                eq(
                  analyticsEvents.eventType,
                  "agent.verification.tool_execution",
                ),
              ),
            )
        : [];
      const escalationRows = rows.length
        ? await database
            .select({
              sessionId: analyticsEvents.sessionId,
              success: analyticsEvents.success,
            })
            .from(analyticsEvents)
            .where(
              and(
                inArray(
                  analyticsEvents.sessionId,
                  rows.map((row) => row.id),
                ),
                eq(analyticsEvents.eventType, "agent.verification.escalation"),
              ),
            )
        : [];
      const humanGateRows = rows.length
        ? await database
            .select({ sessionId: analyticsEvents.sessionId })
            .from(analyticsEvents)
            .where(
              and(
                inArray(
                  analyticsEvents.sessionId,
                  rows.map((row) => row.id),
                ),
                eq(
                  analyticsEvents.eventType,
                  "agent.human_intervention.requested",
                ),
              ),
            )
        : [];
      const resumedWaitRows = rows.length
        ? await database
            .select({
              sessionId: analyticsEvents.sessionId,
              waitMs: analyticsEvents.latencyMs,
            })
            .from(analyticsEvents)
            .where(
              and(
                inArray(
                  analyticsEvents.sessionId,
                  rows.map((row) => row.id),
                ),
                eq(
                  analyticsEvents.eventType,
                  "agent.human_intervention.resolved",
                ),
              ),
            )
        : [];
      const completedRows = rows.length
        ? await database
            .selectDistinctOn([analyticsEvents.sessionId], {
              sessionId: analyticsEvents.sessionId,
              properties: analyticsEvents.properties,
            })
            .from(analyticsEvents)
            .where(
              and(
                inArray(
                  analyticsEvents.sessionId,
                  rows.map((row) => row.id),
                ),
                eq(analyticsEvents.eventType, "agent.turn.completed"),
              ),
            )
            // A retry may write another completion with a different idempotency key. The most recent
            // completion is canonical; otherwise one session's metrics depend on database row order.
            .orderBy(
              analyticsEvents.sessionId,
              desc(analyticsEvents.occurredAt),
              desc(analyticsEvents.createdAt),
              desc(analyticsEvents.id),
            )
        : [];
      const toolVerification = new Map(
        verificationRows.map((row) => [row.sessionId, row.success]),
      );
      const escalation = new Map(
        escalationRows.map((row) => [
          row.sessionId,
          row.success === true ? "reached" : "failed",
        ]),
      );
      const humanGate = new Set(humanGateRows.map((row) => row.sessionId));
      const resumedWait = new Map(
        resumedWaitRows.map((row) => [row.sessionId, row.waitMs ?? 0]),
      );
      const completionMetrics = new Map(
        completedRows.map((row) => {
          const properties = row.properties as {
            humanWaitMs?: unknown;
            toolCalls?: unknown;
          };
          const humanWaitMs = properties.humanWaitMs;
          const toolCalls = properties.toolCalls;
          return [
            row.sessionId,
            {
              humanWaitMs:
                typeof humanWaitMs === "number" && humanWaitMs >= 0
                  ? humanWaitMs
                  : 0,
              toolCalls:
                typeof toolCalls === "number" &&
                Number.isInteger(toolCalls) &&
                toolCalls >= 0
                  ? toolCalls
                  : 0,
            },
          ];
        }),
      );
      return {
        sessions: rows.map((row) => {
          const { humanWaitMs: inTurnWaitMs, toolCalls } =
            completionMetrics.get(row.id) ?? {
              humanWaitMs: 0,
              toolCalls: 0,
            };
          const resumedWaitMs = resumedWait.get(row.id) ?? 0;
          const humanWaitMs = inTurnWaitMs + resumedWaitMs;
          return {
            ...row,
            latencyMs:
              row.latencyMs === null ? null : row.latencyMs + resumedWaitMs,
            toolVerified: toolVerification.get(row.id) ?? null,
            escalation: escalation.get(row.id) ?? null,
            humanIntervention: humanGate.has(row.id),
            humanWaitMs,
            toolCalls,
            activeLatencyMs:
              row.latencyMs === null
                ? null
                : Math.max(0, row.latencyMs - inTurnWaitMs),
          };
        }),
      };
    },

    async detail(sessionId: string) {
      const [session] = await database
        .select()
        .from(analyticsSessions)
        .where(eq(analyticsSessions.id, sessionId))
        .limit(1);
      if (!session) return null;
      const [events, spans, feedback] = await Promise.all([
        database
          .select()
          .from(analyticsEvents)
          .where(eq(analyticsEvents.sessionId, sessionId))
          .orderBy(analyticsEvents.occurredAt),
        database
          .select()
          .from(analyticsSpans)
          .where(eq(analyticsSpans.sessionId, sessionId))
          .orderBy(analyticsSpans.startedAt),
        database
          .select()
          .from(analyticsFeedback)
          .where(eq(analyticsFeedback.sessionId, sessionId))
          .orderBy(analyticsFeedback.createdAt),
      ]);
      return { session, events, spans, feedback };
    },

    async overview() {
      /*
       * Exactly one completion per session before any aggregate.
       *
       * The source/idempotency constraint prevents the same event from being written twice, but it
       * does not prevent a retry from using a new key. Joining raw completion rows made that one
       * session count twice and weighted latency, human wait, tokens, and cost by retry count. The
       * latest completion is the canonical final state, matching list().
       */
      const completedEvents = database
        .selectDistinctOn([analyticsEvents.sessionId], {
          sessionId: analyticsEvents.sessionId,
          properties: analyticsEvents.properties,
        })
        .from(analyticsEvents)
        .where(eq(analyticsEvents.eventType, "agent.turn.completed"))
        .orderBy(
          analyticsEvents.sessionId,
          desc(analyticsEvents.occurredAt),
          desc(analyticsEvents.createdAt),
          desc(analyticsEvents.id),
        )
        .as("latest_completed_event");
      const resumedWaitEvents = database
        .select({
          sessionId: analyticsEvents.sessionId,
          waitMs:
            sql<number>`coalesce(sum(${analyticsEvents.latencyMs}), 0)::int`.as(
              "wait_ms",
            ),
        })
        .from(analyticsEvents)
        .where(
          eq(analyticsEvents.eventType, "agent.human_intervention.resolved"),
        )
        .groupBy(analyticsEvents.sessionId)
        .as("human_resumed_wait");
      const recordedHumanWait = sql<number>`case when ${completedEvents.properties}->>'humanWaitMs' ~ '^\\d+$' then (${completedEvents.properties}->>'humanWaitMs')::int else 0 end`;
      const externalHumanWait = sql<number>`coalesce(${resumedWaitEvents.waitMs}, 0)`;
      const totalHumanWait = sql<number>`${recordedHumanWait} + ${externalHumanWait}`;
      const recordedToolCalls = sql<number>`case when ${completedEvents.properties}->>'toolCalls' ~ '^\\d+$' then (${completedEvents.properties}->>'toolCalls')::int else 0 end`;
      const activeLatency = sql<number>`case when ${analyticsSessions.latencyMs} is null then null else greatest(${analyticsSessions.latencyMs} - ${recordedHumanWait}, 0) end`;
      const totalLatency = sql<number>`case when ${analyticsSessions.latencyMs} is null then null else ${analyticsSessions.latencyMs} + ${externalHumanWait} end`;
      const [totals] = await database
        .select({
          sessions: sql<number>`count(*)::int`,
          users: sql<number>`count(distinct ${analyticsSessions.userId})::int`,
          agents: sql<number>`count(distinct ${analyticsSessions.agentId})::int`,
          evaluated: sql<number>`count(*) filter (where ${analyticsSessions.taskCompleted} is not null)::int`,
          successful: sql<number>`count(*) filter (where ${analyticsSessions.taskCompleted} = true)::int`,
          failed: sql<number>`count(*) filter (where ${analyticsSessions.technicalFailure} = true or ${analyticsSessions.toolFailure} = true)::int`,
          avgLatencyMs: sql<number>`coalesce(avg(${totalLatency}), 0)::int`,
          avgActiveLatencyMs: sql<number>`coalesce(avg(${activeLatency}), 0)::int`,
          totalHumanWaitMs: sql<number>`coalesce(sum(${totalHumanWait}), 0)::int`,
          totalToolCalls: sql<number>`coalesce(sum(${recordedToolCalls}), 0)::int`,
          avgToolCalls: sql<number>`coalesce(avg(${recordedToolCalls}), 0)::float`,
          totalTokens: sql<number>`coalesce(sum(${analyticsSessions.totalTokens}), 0)::int`,
          costMicros: sql<number>`coalesce(sum(${analyticsSessions.costMicros}), 0)::int`,
        })
        .from(analyticsSessions)
        .leftJoin(
          completedEvents,
          eq(completedEvents.sessionId, analyticsSessions.id),
        )
        .leftJoin(
          resumedWaitEvents,
          eq(resumedWaitEvents.sessionId, analyticsSessions.id),
        );
      const models = await database
        .select({
          model: analyticsSessions.model,
          sessions: sql<number>`count(*)::int`,
          avgLatencyMs: sql<number>`coalesce(avg(${totalLatency}), 0)::int`,
          avgActiveLatencyMs: sql<number>`coalesce(avg(${activeLatency}), 0)::int`,
          failureRate: sql<number>`coalesce(avg(case when ${analyticsSessions.technicalFailure} or ${analyticsSessions.toolFailure} then 1 else 0 end), 0)::float`,
          costMicros: sql<number>`coalesce(sum(${analyticsSessions.costMicros}), 0)::int`,
        })
        .from(analyticsSessions)
        .leftJoin(
          completedEvents,
          eq(completedEvents.sessionId, analyticsSessions.id),
        )
        .leftJoin(
          resumedWaitEvents,
          eq(resumedWaitEvents.sessionId, analyticsSessions.id),
        )
        .groupBy(analyticsSessions.model)
        .orderBy(desc(sql`count(*)`));
      return { totals, models };
    },

    async verifyToolEvidence(actorUserId: string, sessionId: string) {
      const [session] = await database
        .select({
          id: analyticsSessions.id,
          userId: analyticsSessions.userId,
          agentId: analyticsSessions.agentId,
          properties: analyticsSessions.properties,
          startedAt: analyticsSessions.startedAt,
          endedAt: analyticsSessions.endedAt,
        })
        .from(analyticsSessions)
        .where(eq(analyticsSessions.id, sessionId))
        .limit(1);
      if (!session || session.userId !== actorUserId) return null;

      const observedRows = await database
        .select({ name: analyticsEvents.name })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.sessionId, sessionId),
            eq(analyticsEvents.eventType, "agent.tool.observed"),
          ),
        )
        .orderBy(analyticsEvents.occurredAt);
      const observed = observedRows
        .map((row) => toolRefFromModelName(row.name))
        .filter((ref): ref is string => ref !== null);
      if (observed.length === 0) {
        return { status: "not_applicable" as const, observed: 0 };
      }

      const properties = session.properties as Record<string, unknown>;
      const threadId =
        typeof properties.threadId === "string" ? properties.threadId : "";
      if (!threadId || !session.agentId) {
        return {
          status: "inconclusive" as const,
          reason: "The trace has no signed thread or agent identity.",
          observed: observed.length,
        };
      }

      const evidenceRows = await database
        .select({
          id: auditEvents.id,
          targetId: auditEvents.targetId,
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          and(
            inArray(auditEvents.eventType, [
              "mcp.call_succeeded",
              "mcp.call_failed",
              "mcp.call_rejected",
              "agent.handoff_delivered",
              "agent.handoff_refused",
            ]),
            gte(auditEvents.createdAt, session.startedAt),
            // A handoff is asynchronous by design. Give its worker time to deliver after the parent
            // turn has completed; MCP calls still get filtered back to the turn boundary below.
            lte(
              auditEvents.createdAt,
              new Date(
                (session.endedAt ?? new Date()).getTime() + 10 * 60 * 1_000,
              ),
            ),
            sql`${auditEvents.payload}->>'threadId' = ${threadId}`,
            sql`${auditEvents.payload}->>'bot' = ${session.agentId}`,
            or(
              sql`${auditEvents.payload}->>'actor' = ${actorUserId}`,
              eq(auditEvents.actorUserId, actorUserId),
            ),
          ),
        )
        .orderBy(auditEvents.createdAt);
      const evidence = evidenceRows.flatMap((row) => {
        if (
          row.eventType !== "agent.handoff_delivered" &&
          session.endedAt &&
          row.createdAt > session.endedAt
        ) {
          return [];
        }
        if (
          row.eventType === "mcp.call_rejected" &&
          (row.payload as { decision?: { carriedOut?: boolean } }).decision
            ?.carriedOut === true
        ) {
          // Dry-run policy evidence is not terminal: the call continued to its real outcome.
          return [];
        }
        return [
          {
            id: row.id,
            targetId:
              row.eventType === "agent.handoff_delivered" ||
              row.eventType === "agent.handoff_refused"
                ? "bot/message_bot"
                : row.targetId,
            eventType: row.eventType as
              | "mcp.call_succeeded"
              | "mcp.call_failed"
              | "mcp.call_rejected"
              | "agent.handoff_delivered"
              | "agent.handoff_refused",
          },
        ];
      });
      const verdict = verifyToolExecution(observed, evidence);
      const handoffPending =
        verdict.unmatched.includes("bot/message_bot") &&
        (!session.endedAt ||
          Date.now() <= session.endedAt.getTime() + 10 * 60 * 1_000);
      if (handoffPending) {
        /*
         * `message_bot` returns when the hop is durably queued; delivery happens asynchronously.
         * Absence during that window is not proof of failure, and persisting it as one races the
         * worker on every successful handoff. The route polls this pending state briefly; after the
         * window, a genuinely missing delivery becomes the same failed proof as any other tool.
         */
        return {
          status: "pending" as const,
          reason: "The delegated Bot has not finished delivery yet.",
          ...verdict,
        };
      }
      const occurredAt = new Date();

      await database.transaction(async (tx) => {
        await tx
          .insert(analyticsEvents)
          .values({
            sessionId,
            source: "openbot-verifier",
            idempotencyKey: `${sessionId}:tool-execution:v1`,
            eventType: "agent.verification.tool_execution",
            name: "Tool execution integrity",
            userId: actorUserId,
            agentId: session.agentId,
            success: verdict.passed,
            properties: {
              verifierVersion: 2,
              observed: verdict.observed,
              matched: verdict.matched,
              unmatched: verdict.unmatched,
              operationalFailures: verdict.operationalFailures,
              unresolvedOperationalFailures:
                verdict.unresolvedOperationalFailures,
              rejected: verdict.rejected,
              auditEventIds: verdict.auditEventIds,
            },
            occurredAt,
          })
          .onConflictDoUpdate({
            target: [analyticsEvents.source, analyticsEvents.idempotencyKey],
            set: {
              success: verdict.passed,
              properties: {
                verifierVersion: 2,
                observed: verdict.observed,
                matched: verdict.matched,
                unmatched: verdict.unmatched,
                operationalFailures: verdict.operationalFailures,
                unresolvedOperationalFailures:
                  verdict.unresolvedOperationalFailures,
                rejected: verdict.rejected,
                auditEventIds: verdict.auditEventIds,
              },
              occurredAt,
            },
          });
        await tx
          .update(analyticsSessions)
          .set({
            // Missing audit proof is an integrity failure. A matched vendor failure is an
            // operational failure. A matched policy rejection is verified control behavior.
            // A failed attempt followed by a later successful governed execution is recovery,
            // not a failed session. Keep every failed attempt in verifier evidence, but only mark
            // the session failed when proof is missing or the final operational result is failure.
            toolFailure:
              !verdict.passed ||
              verdict.unresolvedOperationalFailures.length > 0,
            updatedAt: occurredAt,
          })
          .where(eq(analyticsSessions.id, sessionId));
      });

      return {
        status: verdict.passed ? ("verified" as const) : ("failed" as const),
        ...verdict,
      };
    },

    async verifyEscalationEvidence(actorUserId: string, sessionId: string) {
      const [session] = await database
        .select({
          userId: analyticsSessions.userId,
          agentId: analyticsSessions.agentId,
          properties: analyticsSessions.properties,
          startedAt: analyticsSessions.startedAt,
          endedAt: analyticsSessions.endedAt,
        })
        .from(analyticsSessions)
        .where(eq(analyticsSessions.id, sessionId))
        .limit(1);
      if (!session || session.userId !== actorUserId) return null;

      const properties = session.properties as Record<string, unknown>;
      const threadId =
        typeof properties.threadId === "string" ? properties.threadId : "";
      if (!threadId || !session.agentId) {
        return { status: "inconclusive" as const };
      }

      const [evidence] = await database
        .select({ id: auditEvents.id, eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(
          and(
            inArray(auditEvents.eventType, [
              "agent.escalated",
              "agent.escalation_failed",
            ]),
            eq(auditEvents.actorUserId, actorUserId),
            eq(auditEvents.targetId, session.agentId),
            gte(auditEvents.createdAt, session.startedAt),
            lte(auditEvents.createdAt, session.endedAt ?? new Date()),
            sql`${auditEvents.payload}->>'threadId' = ${threadId}`,
          ),
        )
        .orderBy(auditEvents.createdAt)
        .limit(1);
      if (!evidence) return { status: "not_applicable" as const };

      const reached = evidence.eventType === "agent.escalated";
      const occurredAt = new Date();
      await database
        .insert(analyticsEvents)
        .values({
          sessionId,
          source: "openbot-verifier",
          idempotencyKey: `${sessionId}:escalation:v1`,
          eventType: "agent.verification.escalation",
          name: "Human escalation delivery",
          userId: actorUserId,
          agentId: session.agentId,
          success: reached,
          properties: {
            verifierVersion: 1,
            auditEventId: evidence.id,
            outcome: reached ? "reached" : "failed",
          },
          occurredAt,
        })
        .onConflictDoUpdate({
          target: [analyticsEvents.source, analyticsEvents.idempotencyKey],
          set: {
            success: reached,
            properties: {
              verifierVersion: 1,
              auditEventId: evidence.id,
              outcome: reached ? "reached" : "failed",
            },
            occurredAt,
          },
        });
      return {
        status: reached ? ("reached" as const) : ("failed" as const),
        auditEventId: evidence.id,
      };
    },

    async feedback(
      actorUserId: string,
      sessionId: string,
      input: {
        rating?: number;
        negative?: boolean;
        taskCompleted?: boolean;
        category?: string;
        note?: string;
      },
    ) {
      return database.transaction(async (tx) => {
        const [session] = await tx
          .select({
            userId: analyticsSessions.userId,
            privacyMode: analyticsSessions.privacyMode,
          })
          .from(analyticsSessions)
          .where(eq(analyticsSessions.id, sessionId))
          .limit(1);
        // A missing session and somebody else's session are deliberately indistinguishable.
        if (!session || session.userId !== actorUserId) {
          throw new Error("Analytics session belongs to another user.");
        }

        const [row] = await tx
          .insert(analyticsFeedback)
          .values({
            sessionId,
            userId: actorUserId,
            rating: input.rating,
            negative: input.negative ?? false,
            category: input.category?.slice(0, 200),
            // Feedback is part of the trace and inherits its privacy boundary. A metadata-only
            // session must not gain raw conversation through a side door labeled "note".
            note: input.note
              ? contentForPrivacyMode(input.note, session.privacyMode)
              : null,
          })
          .returning();

        if (input.taskCompleted !== undefined || input.negative) {
          const taskCompleted = input.taskCompleted ?? false;
          await tx
            .update(analyticsSessions)
            .set({
              taskCompleted,
              negativeFeedback: input.negative ?? !taskCompleted,
              updatedAt: new Date(),
            })
            .where(eq(analyticsSessions.id, sessionId));
        }
        return row;
      });
    },

    /** Minimal owner-scoped state needed to restore the conversation's feedback control. */
    async evaluation(actorUserId: string, sessionId: string) {
      const [session] = await database
        .select({
          userId: analyticsSessions.userId,
          status: analyticsSessions.status,
          taskCompleted: analyticsSessions.taskCompleted,
        })
        .from(analyticsSessions)
        .where(eq(analyticsSessions.id, sessionId))
        .limit(1);
      if (!session || session.userId !== actorUserId) return null;
      return {
        status: session.status,
        taskCompleted: session.taskCompleted,
      };
    },
  };
}
