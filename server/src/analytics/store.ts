import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  ScoredEpisode,
  VerifiableEpisode,
} from "../../../shared/verifiable-reward";
import { scoreEpisode } from "../../../shared/verifiable-reward";
import type { Database } from "../db/client";
import {
  analyticsDatasetSessions,
  analyticsDatasets,
  analyticsEvalResults,
  analyticsEvalRuns,
  analyticsEvaluators,
  analyticsEvaluatorVersions,
  analyticsEvents,
  analyticsFeedback,
  analyticsReviews,
  analyticsSessions,
  analyticsSessionTopics,
  analyticsSpans,
  analyticsTopics,
  auditEvents,
  verifiedValueOutcomes,
} from "../db/schema";
import {
  type AnalyticsPrivacyMode,
  contentForPrivacyMode,
  redactAnalyticsProperties,
  redactAnalyticsText,
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
  offset?: number;
};

export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>;

/**
 * Allocate model usage to an internal chargeback rate when the provider cannot report a bill.
 * Rates are USD per million tokens; the result uses the existing millionths-of-a-dollar column.
 * An explicit provider-reported cost always wins, so chargeback can never overwrite real spend.
 */
export function analyticsCostMicros(
  usage: { inputTokens?: number; outputTokens?: number; costMicros?: number },
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (usage.costMicros !== undefined) return Math.max(0, usage.costMicros);
  const rate = (name: string) => {
    const parsed = Number(environment[name] ?? 0);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return Math.round(
    Math.max(0, usage.inputTokens ?? 0) *
      rate("ANALYTICS_CHARGEBACK_INPUT_USD_PER_MILLION_TOKENS") +
      Math.max(0, usage.outputTokens ?? 0) *
        rate("ANALYTICS_CHARGEBACK_OUTPUT_USD_PER_MILLION_TOKENS"),
  );
}

function date(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

const CLUSTER_DIMENSIONS = 48;
const CLUSTER_STOP_WORDS = new Set([
  "agent",
  "openbot",
  "runtime",
  "channel",
  "completed",
  "unknown",
  "turn",
]);

function clusterTokens(parts: Array<string | null | undefined>) {
  return (
    parts
      .join(" ")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.:-]{2,}/g)
      ?.filter((token) => !CLUSTER_STOP_WORDS.has(token)) ?? []
  );
}

function tokenBucket(token: string) {
  let hash = 2166136261;
  for (const character of token) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % CLUSTER_DIMENSIONS;
}

function clusterVector(tokens: readonly string[]) {
  const vector = Array.from({ length: CLUSTER_DIMENSIONS }, () => 0);
  for (const token of tokens) vector[tokenBucket(token)] += 1;
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value ** 2, 0),
  );
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

const vectorDistance = (left: readonly number[], right: readonly number[]) =>
  1 - left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

function behavioralClusters(rows: Array<{ id: string; tokens: string[] }>) {
  if (rows.length === 0) return [];
  const vectors = rows.map((row) => clusterVector(row.tokens));
  const count = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(rows.length / 2))));
  const centroids = [vectors[0] ?? []];
  while (centroids.length < count) {
    let farthest = 0;
    let farthestDistance = -1;
    vectors.forEach((vector, index) => {
      const distance = Math.min(
        ...centroids.map((centroid) => vectorDistance(vector, centroid)),
      );
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    });
    centroids.push([...(vectors[farthest] ?? [])]);
  }
  let assignments = vectors.map(() => 0);
  for (let pass = 0; pass < 10; pass += 1) {
    assignments = vectors.map((vector) => {
      const distances = centroids.map((centroid) =>
        vectorDistance(vector, centroid),
      );
      return distances.indexOf(Math.min(...distances));
    });
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const members = vectors.filter(
        (_, index) => assignments[index] === cluster,
      );
      if (members.length === 0) continue;
      centroids[cluster] = Array.from(
        { length: CLUSTER_DIMENSIONS },
        (_, dimension) =>
          members.reduce((sum, vector) => sum + (vector[dimension] ?? 0), 0) /
          members.length,
      );
    }
  }
  return rows.map((row, index) => ({
    ...row,
    cluster: assignments[index] ?? 0,
  }));
}

export function createAnalyticsStore(database: Database, tenantId?: string) {
  let llmJudge: ((prompt: string) => Promise<string>) | undefined;
  return {
    setLlmJudge(judge: (prompt: string) => Promise<string>) {
      llmJudge = judge;
    },
    /** Persist a privacy-safe, replayable runtime episode before evaluators consume it. */
    async recordRuntimeEpisode(input: {
      actorUserId?: string;
      agentId?: string;
      threadId?: string;
      episode: VerifiableEpisode;
      scored: ScoredEpisode;
      toolCalls?: Array<{ id: string; name: string }>;
      usage?: {
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }) {
      const occurredAt = new Date();
      await database.transaction(async (tx) => {
        await tx
          .insert(analyticsSessions)
          .values({
            id: input.episode.id,
            userId: input.actorUserId ?? null,
            agentId: input.agentId ?? null,
            source: "openbot-runtime",
            privacyMode: "metadata_only",
            status:
              input.episode.terminatedBecause === "success"
                ? "completed"
                : "failed",
            taskCompleted: input.scored.eligibleForTraining,
            technicalFailure: input.episode.terminatedBecause === "failure",
            model: input.usage?.model,
            totalTokens: input.usage?.totalTokens ?? 0,
            properties: {
              threadId: input.threadId,
              taskId: input.episode.taskId,
              taskVersion: input.episode.taskVersion,
            },
            startedAt: occurredAt,
            endedAt: occurredAt,
          })
          .onConflictDoUpdate({
            target: analyticsSessions.id,
            set: {
              status:
                input.episode.terminatedBecause === "success"
                  ? "completed"
                  : "failed",
              taskCompleted: input.scored.eligibleForTraining,
              model: input.usage?.model,
              totalTokens: input.usage?.totalTokens ?? 0,
              endedAt: occurredAt,
              updatedAt: occurredAt,
            },
          });
        const inserted = await tx
          .insert(analyticsEvents)
          .values({
            sessionId: input.episode.id,
            source: "openbot-runtime",
            idempotencyKey: `${input.episode.id}:episode:${input.episode.finalStateHash}`,
            eventType: "agent.verification.episode",
            name: "Live verifiable reward episode",
            userId: input.actorUserId ?? null,
            agentId: input.agentId ?? null,
            success: input.scored.eligibleForTraining,
            properties: {
              episode: input.episode,
              scored: input.scored,
            },
            occurredAt,
          })
          .onConflictDoNothing()
          .returning({ id: analyticsEvents.id });
        if (input.toolCalls && input.toolCalls.length > 0) {
          await tx
            .insert(analyticsEvents)
            .values(
              input.toolCalls.map((tool) => ({
                sessionId: input.episode.id,
                source: "openbot-runtime",
                idempotencyKey: `${input.episode.id}:tool:${tool.id}`,
                eventType: "agent.tool.observed",
                name: tool.name,
                userId: input.actorUserId ?? null,
                agentId: input.agentId ?? null,
                model: input.usage?.model,
                success: true,
                properties: {
                  toolCallId: tool.id,
                  executionSurface: "server-runtime",
                },
                occurredAt,
              })),
            )
            .onConflictDoNothing();
        }
        if (input.usage) {
          await tx
            .insert(analyticsEvents)
            .values({
              sessionId: input.episode.id,
              source: "openbot-runtime",
              idempotencyKey: `${input.episode.id}:usage:${input.episode.finalStateHash}`,
              eventType: "agent.run.usage",
              name: "Runtime model usage",
              userId: input.actorUserId ?? null,
              agentId: input.agentId ?? null,
              model: input.usage.model,
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              costMicros: analyticsCostMicros(input.usage),
              success: input.episode.terminatedBecause === "success",
              properties: { totalTokens: input.usage.totalTokens },
              occurredAt,
            })
            .onConflictDoNothing();
        }
        const debtFailure = input.episode.verifierResults.find(
          (result) => result.id === "technical-debt-budget" && !result.passed,
        );
        if (inserted.length > 0 && debtFailure) {
          await tx.insert(analyticsReviews).values({
            sessionId: input.episode.id,
            reviewerId: "unassigned",
            status: "pending",
            label: "technical-debt-budget",
            errorCategory: "maintainability",
            note: `Automatic promotion was refused: ${input.scored.reasons.join("; ")}`,
          });
        }
      });
      return { episodeId: input.episode.id };
    },
    /** Record an administrator-confirmed product outcome without rewriting its source session. */
    async recordBusinessOutcome(
      actorUserId: string,
      sessionId: string,
      input: {
        name: string;
        success: boolean;
        revenueMicros: number;
        humanMinutesSaved: number;
        laborValueMicros: number;
      },
    ) {
      const [session] = await database
        .select({ agentId: analyticsSessions.agentId })
        .from(analyticsSessions)
        .where(eq(analyticsSessions.id, sessionId))
        .limit(1);
      if (!session) throw new Error("Analytics session not found.");
      const [event] = await database
        .insert(analyticsEvents)
        .values({
          sessionId,
          source: "openbot-admin",
          idempotencyKey: `business-outcome:${sessionId}:${randomUUID()}`,
          eventType: "agent.business.outcome",
          name: input.name,
          userId: actorUserId,
          agentId: session.agentId,
          success: input.success,
          properties: {
            revenueMicros: input.revenueMicros,
            humanMinutesSaved: input.humanMinutesSaved,
            laborValueMicros: input.laborValueMicros,
          },
        })
        .returning();
      if (!event) throw new Error("Business outcome was not recorded.");
      return event;
    },
    /**
     * Close traces whose browser disappeared without delivering a terminal event.
     * The conditional update is the lease: concurrent replicas can sweep safely and only the
     * process that changed a row emits its idempotent abandonment event.
     */
    async abandonStaleSessions(cutoff: Date, limit = 500) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.valueOf())) {
        throw new Error("A valid stale-session cutoff is required.");
      }
      const cappedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
      return database.transaction(async (tx) => {
        const candidates = await tx
          .select({ id: analyticsSessions.id })
          .from(analyticsSessions)
          .where(
            and(
              eq(analyticsSessions.status, "running"),
              lt(analyticsSessions.updatedAt, cutoff),
            ),
          )
          .orderBy(analyticsSessions.updatedAt)
          .limit(cappedLimit)
          .for("update", { skipLocked: true });
        if (candidates.length === 0) return 0;

        const ids = candidates.map(({ id }) => id);
        const endedAt = new Date();
        const closed = await tx
          .update(analyticsSessions)
          .set({
            status: "abandoned",
            technicalFailure: true,
            endedAt,
            updatedAt: endedAt,
          })
          .where(
            and(
              inArray(analyticsSessions.id, ids),
              eq(analyticsSessions.status, "running"),
            ),
          )
          .returning({
            id: analyticsSessions.id,
            userId: analyticsSessions.userId,
            agentId: analyticsSessions.agentId,
            startedAt: analyticsSessions.startedAt,
          });
        if (closed.length > 0) {
          await tx
            .insert(analyticsEvents)
            .values(
              closed.map((session) => ({
                sessionId: session.id,
                source: "openbot-session-sweeper",
                idempotencyKey: `${session.id}:abandoned:v1`,
                eventType: "agent.turn.abandoned",
                name: "Stale channel turn abandoned",
                userId: session.userId,
                agentId: session.agentId,
                latencyMs: Math.max(
                  0,
                  endedAt.getTime() - session.startedAt.getTime(),
                ),
                success: false,
                errorType: "terminal_event_missing",
                properties: {
                  cutoff: cutoff.toISOString(),
                  verifierVersion: 1,
                },
                occurredAt: endedAt,
              })),
            )
            .onConflictDoNothing();
        }
        return closed.length;
      });
    },

    /** Delete one bounded retention batch. Child events and spans follow the session cascade. */
    async purgeSessionsBefore(cutoff: Date, limit = 1_000) {
      const cappedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
      return database.transaction(async (tx) => {
        const [lock] = await tx.execute<{ acquired: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext('openbot.analytics-retention')) as acquired`,
        );
        if (!lock?.acquired) return null;
        const candidates = await tx
          .select({ id: analyticsSessions.id })
          .from(analyticsSessions)
          .where(lt(analyticsSessions.startedAt, cutoff))
          .orderBy(analyticsSessions.startedAt)
          .limit(cappedLimit)
          .for("update", { skipLocked: true });
        if (candidates.length === 0) return 0;
        const deleted = await tx
          .delete(analyticsSessions)
          .where(
            inArray(
              analyticsSessions.id,
              candidates.map(({ id }) => id),
            ),
          )
          .returning({ id: analyticsSessions.id });
        return deleted.length;
      });
    },

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
              mode === "customer_enriched" && input.session.summary
                ? redactAnalyticsText(input.session.summary.slice(0, 10_000))
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
          const costMicros = analyticsCostMicros(event);
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
              costMicros,
              success: event.success,
              errorType: event.errorType?.slice(0, 200),
              properties: redactAnalyticsProperties(event.properties),
              occurredAt: date(event.occurredAt) ?? now,
            })
            .onConflictDoNothing()
            .returning({ id: analyticsEvents.id });
          acceptedEvents += inserted.length;
          if (inserted.length)
            acceptedEventValues.push({ ...event, costMicros });
        }

        let acceptedSpans = 0;
        for (const span of spans) {
          const costMicros = analyticsCostMicros(span);
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
              costMicros,
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
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
        .offset(Math.min(Math.max(query.offset ?? 0, 0), 100_000));
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
      const [events, spans, feedback, reviews, topics] = await Promise.all([
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
        database
          .select()
          .from(analyticsReviews)
          .where(eq(analyticsReviews.sessionId, sessionId))
          .orderBy(desc(analyticsReviews.updatedAt)),
        database
          .select({
            id: analyticsTopics.id,
            name: analyticsTopics.name,
            source: analyticsSessionTopics.source,
          })
          .from(analyticsSessionTopics)
          .innerJoin(
            analyticsTopics,
            eq(analyticsSessionTopics.topicId, analyticsTopics.id),
          )
          .where(eq(analyticsSessionTopics.sessionId, sessionId)),
      ]);
      return { session, events, spans, feedback, reviews, topics };
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
          totalTokens: sql<number>`coalesce(sum(${analyticsSessions.totalTokens}), 0)::float8`,
          costMicros: sql<number>`coalesce(sum(${analyticsSessions.costMicros}), 0)::float8`,
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
          costMicros: sql<number>`coalesce(sum(${analyticsSessions.costMicros}), 0)::float8`,
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
      // CFO-facing value comes only from signed source evidence joined to a human-approved
      // workflow. Administrator annotations remain available elsewhere but cannot inflate ROI.
      const [weeklyValue] = await database
        .select({
          outcomes: sql<number>`count(*)::int`,
          humanMinutesSaved: sql<number>`coalesce(sum(${verifiedValueOutcomes.humanMinutesSaved}), 0)::float8`,
          laborValueMicros: sql<number>`coalesce(sum(${verifiedValueOutcomes.laborValueMicros}), 0)::float8`,
          revenueMicros: sql<number>`coalesce(sum(${verifiedValueOutcomes.revenueMicros}), 0)::float8`,
        })
        .from(verifiedValueOutcomes)
        .where(
          and(
            gte(
              verifiedValueOutcomes.createdAt,
              sql`date_trunc('week', now())`,
            ),
            tenantId ? eq(verifiedValueOutcomes.tenantId, tenantId) : undefined,
          ),
        );
      const recentValueEvidence = await database
        .select({
          id: verifiedValueOutcomes.id,
          workflowRunId: verifiedValueOutcomes.workflowRunId,
          source: verifiedValueOutcomes.source,
          evidenceRef: verifiedValueOutcomes.evidenceRef,
          evidenceChecksum: verifiedValueOutcomes.evidenceChecksum,
          humanMinutesSaved: verifiedValueOutcomes.humanMinutesSaved,
          laborValueMicros: verifiedValueOutcomes.laborValueMicros,
          revenueMicros: verifiedValueOutcomes.revenueMicros,
          createdAt: verifiedValueOutcomes.createdAt,
        })
        .from(verifiedValueOutcomes)
        .where(
          tenantId ? eq(verifiedValueOutcomes.tenantId, tenantId) : undefined,
        )
        .orderBy(desc(verifiedValueOutcomes.createdAt))
        .limit(20);
      const generatedValueMicros =
        (weeklyValue?.laborValueMicros ?? 0) +
        (weeklyValue?.revenueMicros ?? 0);
      return {
        totals,
        models,
        weeklyRoi: {
          outcomes: weeklyValue?.outcomes ?? 0,
          humanMinutesSaved: weeklyValue?.humanMinutesSaved ?? 0,
          laborValueMicros: weeklyValue?.laborValueMicros ?? 0,
          revenueMicros: weeklyValue?.revenueMicros ?? 0,
          generatedValueMicros,
          netValueMicros: generatedValueMicros - (totals?.costMicros ?? 0),
          evidence: recentValueEvidence,
        },
      };
    },

    /** Operational surface for the evaluation assets that used to be schema-only. */
    async governance() {
      const [
        evaluators,
        datasets,
        runs,
        reviews,
        topics,
        toolUsage,
        outcomes,
        topicScorecards,
        [episodeCounts],
        [debtReviewCounts],
      ] = await Promise.all([
        database
          .select()
          .from(analyticsEvaluators)
          .orderBy(desc(analyticsEvaluators.updatedAt))
          .limit(50),
        database
          .select()
          .from(analyticsDatasets)
          .orderBy(desc(analyticsDatasets.updatedAt))
          .limit(50),
        database
          .select()
          .from(analyticsEvalRuns)
          .orderBy(desc(analyticsEvalRuns.createdAt))
          .limit(50),
        database
          .select()
          .from(analyticsReviews)
          .orderBy(desc(analyticsReviews.updatedAt))
          .limit(50),
        database
          .select()
          .from(analyticsTopics)
          .orderBy(analyticsTopics.name)
          .limit(100),
        database
          .select({
            agentId: analyticsEvents.agentId,
            tool: analyticsEvents.name,
            // A browser turn and the server runtime may observe the same call.
            // The stable AG-UI call id makes that one action, not two billable uses.
            calls: sql<number>`count(distinct coalesce(${analyticsEvents.properties}->>'toolCallId', ${analyticsEvents.id}::text))::int`,
            costMicros: sql<number>`coalesce(sum(${analyticsEvents.costMicros}), 0)::float8`,
          })
          .from(analyticsEvents)
          .where(eq(analyticsEvents.eventType, "agent.tool.observed"))
          .groupBy(analyticsEvents.agentId, analyticsEvents.name)
          .orderBy(desc(sql`count(*)`))
          .limit(100),
        database
          .select({
            name: analyticsEvents.name,
            agentId: analyticsEvents.agentId,
            conversions: sql<number>`count(*) filter (where ${analyticsEvents.success} = true)::int`,
            revenueMicros: sql<number>`coalesce(sum(case when ${analyticsEvents.properties}->>'revenueMicros' ~ '^[0-9]+$' then (${analyticsEvents.properties}->>'revenueMicros')::bigint else 0 end), 0)::float8`,
            taskSuccessRate: sql<number>`coalesce(avg(case when ${analyticsSessions.taskCompleted} = true then 1 when ${analyticsSessions.taskCompleted} = false then 0 else null end), 0)::float8`,
          })
          .from(analyticsEvents)
          .innerJoin(
            analyticsSessions,
            eq(analyticsEvents.sessionId, analyticsSessions.id),
          )
          .where(eq(analyticsEvents.eventType, "agent.business.outcome"))
          .groupBy(analyticsEvents.name, analyticsEvents.agentId)
          .limit(100),
        database
          .select({
            topicId: analyticsTopics.id,
            name: analyticsTopics.name,
            sessions: sql<number>`count(*)::int`,
            successRate: sql<number>`coalesce(avg(case when ${analyticsSessions.taskCompleted} = true then 1 when ${analyticsSessions.taskCompleted} = false then 0 else null end), 0)::float8`,
          })
          .from(analyticsSessionTopics)
          .innerJoin(
            analyticsTopics,
            eq(analyticsSessionTopics.topicId, analyticsTopics.id),
          )
          .innerJoin(
            analyticsSessions,
            eq(analyticsSessionTopics.sessionId, analyticsSessions.id),
          )
          .groupBy(analyticsTopics.id, analyticsTopics.name)
          .orderBy(desc(sql`count(*)`))
          .limit(100),
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(analyticsEvents)
          .where(eq(analyticsEvents.eventType, "agent.verification.episode")),
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(analyticsReviews)
          .where(eq(analyticsReviews.label, "technical-debt-budget")),
      ]);
      const journeySessions = await database
        .select({
          id: analyticsSessions.id,
          agentId: analyticsSessions.agentId,
          taskCompleted: analyticsSessions.taskCompleted,
          status: analyticsSessions.status,
          properties: analyticsSessions.properties,
          startedAt: analyticsSessions.startedAt,
          endedAt: analyticsSessions.endedAt,
        })
        .from(analyticsSessions)
        .where(sql`${analyticsSessions.properties}->>'threadId' is not null`)
        .orderBy(analyticsSessions.startedAt)
        .limit(2_000);
      const journeyOutcomes =
        journeySessions.length > 0
          ? await database
              .select({
                sessionId: analyticsEvents.sessionId,
                success: analyticsEvents.success,
                properties: analyticsEvents.properties,
              })
              .from(analyticsEvents)
              .where(
                and(
                  eq(analyticsEvents.eventType, "agent.business.outcome"),
                  inArray(
                    analyticsEvents.sessionId,
                    journeySessions.map((session) => session.id),
                  ),
                ),
              )
          : [];
      const outcomesBySession = new Map<
        string,
        { conversions: number; revenueMicros: number }
      >();
      for (const outcome of journeyOutcomes) {
        const current = outcomesBySession.get(outcome.sessionId) ?? {
          conversions: 0,
          revenueMicros: 0,
        };
        const properties = outcome.properties as Record<string, unknown>;
        const revenue = Number(properties.revenueMicros ?? 0);
        current.conversions += outcome.success === true ? 1 : 0;
        current.revenueMicros +=
          Number.isSafeInteger(revenue) && revenue >= 0 ? revenue : 0;
        outcomesBySession.set(outcome.sessionId, current);
      }
      const groupedJourneys = new Map<string, typeof journeySessions>();
      for (const session of journeySessions) {
        const properties = session.properties as Record<string, unknown>;
        const threadId =
          typeof properties.threadId === "string" ? properties.threadId : "";
        if (!threadId) continue;
        const turns = groupedJourneys.get(threadId) ?? [];
        turns.push(session);
        groupedJourneys.set(threadId, turns);
      }
      const journeys = [...groupedJourneys.entries()]
        .filter(([, turns]) => turns.length >= 2)
        .map(([threadId, turns]) => {
          const first = turns[0];
          const last = turns.at(-1);
          const business = turns.reduce(
            (sum, turn) => {
              const value = outcomesBySession.get(turn.id);
              return {
                conversions: sum.conversions + (value?.conversions ?? 0),
                revenueMicros: sum.revenueMicros + (value?.revenueMicros ?? 0),
              };
            },
            { conversions: 0, revenueMicros: 0 },
          );
          return {
            threadId,
            agentId: last?.agentId ?? first?.agentId ?? null,
            turns: turns.length,
            firstOutcome: first?.taskCompleted ?? null,
            lastOutcome: last?.taskCompleted ?? null,
            improved:
              first?.taskCompleted === false && last?.taskCompleted === true,
            conversions: business.conversions,
            revenueMicros: business.revenueMicros,
            startedAt: first?.startedAt,
            endedAt: last?.endedAt ?? last?.startedAt,
          };
        })
        .sort(
          (left, right) =>
            (right.endedAt?.getTime() ?? 0) - (left.endedAt?.getTime() ?? 0),
        )
        .slice(0, 100);
      return {
        evaluators,
        datasets,
        runs,
        reviews,
        topics,
        toolUsage,
        outcomes,
        topicScorecards,
        journeys,
        verifiedEpisodes: episodeCounts?.count ?? 0,
        debtReviews: debtReviewCounts?.count ?? 0,
      };
    },

    async clusterTopics() {
      const sessions = await database
        .select({
          id: analyticsSessions.id,
          intent: analyticsSessions.intent,
          summary: analyticsSessions.summary,
          source: analyticsSessions.source,
          agentId: analyticsSessions.agentId,
          model: analyticsSessions.model,
          status: analyticsSessions.status,
        })
        .from(analyticsSessions)
        .orderBy(desc(analyticsSessions.startedAt))
        .limit(1_000);
      if (sessions.length === 0) return { assigned: 0, clusters: 0 };
      const eventRows = await database
        .select({
          sessionId: analyticsEvents.sessionId,
          eventType: analyticsEvents.eventType,
          name: analyticsEvents.name,
        })
        .from(analyticsEvents)
        .where(
          inArray(
            analyticsEvents.sessionId,
            sessions.map((session) => session.id),
          ),
        );
      const eventsBySession = new Map<string, string[]>();
      for (const event of eventRows) {
        const values = eventsBySession.get(event.sessionId) ?? [];
        values.push(event.eventType, event.name);
        eventsBySession.set(event.sessionId, values);
      }
      const humanRows = await database
        .select({ sessionId: analyticsSessionTopics.sessionId })
        .from(analyticsSessionTopics)
        .where(eq(analyticsSessionTopics.source, "human"));
      const human = new Set(humanRows.map((row) => row.sessionId));
      const clustered = behavioralClusters(
        sessions
          .filter((session) => !human.has(session.id))
          .map((session) => ({
            id: session.id,
            tokens: clusterTokens([
              session.intent,
              session.summary,
              session.source,
              session.agentId,
              session.model,
              session.status,
              ...(eventsBySession.get(session.id) ?? []),
            ]),
          })),
      );
      const labels = new Map<number, string>();
      for (const row of clustered) {
        if (labels.has(row.cluster)) continue;
        const frequency = new Map<string, number>();
        for (const member of clustered.filter(
          (item) => item.cluster === row.cluster,
        )) {
          for (const token of member.tokens)
            frequency.set(token, (frequency.get(token) ?? 0) + 1);
        }
        const distinctive = [...frequency.entries()]
          .sort(
            (left, right) =>
              right[1] - left[1] || left[0].localeCompare(right[0]),
          )
          .slice(0, 2)
          .map(([token]) => token.replaceAll(/[_.:-]+/g, " "))
          .join(" + ");
        labels.set(
          row.cluster,
          `Behavior · ${distinctive || `cluster ${row.cluster + 1}`}`,
        );
      }
      await database.transaction(async (tx) => {
        await tx
          .delete(analyticsSessionTopics)
          .where(eq(analyticsSessionTopics.source, "cluster"));
        for (const row of clustered) {
          const name =
            labels.get(row.cluster) ?? `Behavior · cluster ${row.cluster + 1}`;
          const [topic] = await tx
            .insert(analyticsTopics)
            .values({
              name,
              description:
                "Unsupervised cluster of intent and observed runtime behavior.",
            })
            .onConflictDoUpdate({
              target: analyticsTopics.name,
              set: { updatedAt: new Date() },
            })
            .returning({ id: analyticsTopics.id });
          if (topic)
            await tx.insert(analyticsSessionTopics).values({
              sessionId: row.id,
              topicId: topic.id,
              confidence: 70,
              source: "cluster",
            });
        }
      });
      return { assigned: clustered.length, clusters: labels.size };
    },

    async ensureBuiltInEvaluators(actorUserId: string) {
      const builtIns = [
        {
          name: "Task Completion",
          description: "Whether the session reached its declared outcome.",
          definition: { signal: "task_completion", threshold: 1 },
        },
        {
          name: "Helpfulness",
          description: "Explicit rating and negative-feedback quality signal.",
          definition: { signal: "helpfulness", threshold: 70 },
        },
        {
          name: "User Friction",
          description: "Human waits, failures, and repeated tool activity.",
          definition: { signal: "user_friction", threshold: 70 },
        },
      ] as const;
      for (const builtIn of builtIns) {
        const [existing] = await database
          .select({ id: analyticsEvaluators.id })
          .from(analyticsEvaluators)
          .where(eq(analyticsEvaluators.name, builtIn.name))
          .limit(1);
        if (existing) continue;
        await database.transaction(async (tx) => {
          const [created] = await tx
            .insert(analyticsEvaluators)
            .values({
              name: builtIn.name,
              description: builtIn.description,
              kind: "code",
              scoreType: "numeric",
              lifecycle: "active",
              activeVersion: 1,
              createdBy: actorUserId,
            })
            .returning({ id: analyticsEvaluators.id });
          if (!created) return;
          await tx.insert(analyticsEvaluatorVersions).values({
            evaluatorId: created.id,
            version: 1,
            definition: builtIn.definition,
            createdBy: actorUserId,
          });
        });
      }
      return this.governance();
    },

    async createEvaluator(
      actorUserId: string,
      input: {
        name: string;
        description?: string;
        kind: "code" | "llm_judge";
        scoreType: "binary" | "categorical" | "numeric";
        definition: Record<string, unknown>;
      },
    ) {
      return database.transaction(async (tx) => {
        const [evaluator] = await tx
          .insert(analyticsEvaluators)
          .values({
            name: input.name,
            description: input.description ?? "",
            kind: input.kind,
            scoreType: input.scoreType,
            lifecycle: "active",
            activeVersion: 1,
            createdBy: actorUserId,
          })
          .returning();
        if (!evaluator) throw new Error("Evaluator was not created.");
        await tx.insert(analyticsEvaluatorVersions).values({
          evaluatorId: evaluator.id,
          version: 1,
          definition: input.definition,
          createdBy: actorUserId,
        });
        return evaluator;
      });
    },

    async createDataset(
      actorUserId: string,
      input: {
        name: string;
        description?: string;
        golden?: boolean;
        sessionIds?: string[];
      },
    ) {
      return database.transaction(async (tx) => {
        const [dataset] = await tx
          .insert(analyticsDatasets)
          .values({
            name: input.name,
            description: input.description ?? "",
            golden: input.golden === true,
            query: {},
            createdBy: actorUserId,
          })
          .returning();
        if (!dataset) throw new Error("Dataset was not created.");
        const ids = [...new Set(input.sessionIds ?? [])];
        if (ids.length > 0) {
          await tx.insert(analyticsDatasetSessions).values(
            ids.map((sessionId) => ({
              datasetId: dataset.id,
              sessionId,
              addedBy: actorUserId,
            })),
          );
        }
        return dataset;
      });
    },

    async reviewSession(
      actorUserId: string,
      sessionId: string,
      input: {
        status: string;
        label?: string;
        errorCategory?: string;
        note?: string;
      },
    ) {
      const [review] = await database
        .insert(analyticsReviews)
        .values({
          sessionId,
          reviewerId: actorUserId,
          status: input.status,
          label: input.label ?? null,
          errorCategory: input.errorCategory ?? null,
          note: input.note ?? null,
        })
        .returning();
      return review;
    },

    async classifyTopic(
      sessionId: string,
      input: { name: string; description?: string; confidence?: number },
    ) {
      return database.transaction(async (tx) => {
        const [topic] = await tx
          .insert(analyticsTopics)
          .values({ name: input.name, description: input.description ?? "" })
          .onConflictDoUpdate({
            target: analyticsTopics.name,
            set: {
              description: input.description ?? "",
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!topic) throw new Error("Topic was not created.");
        await tx
          .insert(analyticsSessionTopics)
          .values({
            sessionId,
            topicId: topic.id,
            confidence: Math.max(0, Math.min(100, input.confidence ?? 100)),
            source: "human",
          })
          .onConflictDoUpdate({
            target: [
              analyticsSessionTopics.sessionId,
              analyticsSessionTopics.topicId,
            ],
            set: {
              confidence: Math.max(0, Math.min(100, input.confidence ?? 100)),
              source: "human",
            },
          });
        return topic;
      });
    },

    async runEvaluator(
      actorUserId: string,
      evaluatorId: string,
      datasetId?: string,
      calibration = false,
      claimedRunId?: string,
    ) {
      const [evaluator] = await database
        .select()
        .from(analyticsEvaluators)
        .where(eq(analyticsEvaluators.id, evaluatorId))
        .limit(1);
      if (!evaluator?.activeVersion)
        throw new Error("Evaluator has no active version.");
      const [version] = await database
        .select()
        .from(analyticsEvaluatorVersions)
        .where(
          and(
            eq(analyticsEvaluatorVersions.evaluatorId, evaluatorId),
            eq(analyticsEvaluatorVersions.version, evaluator.activeVersion),
          ),
        )
        .limit(1);
      if (!version) throw new Error("Evaluator version is missing.");
      const definition = version.definition as {
        signal?: string;
        threshold?: number;
      };
      const sessionRows = datasetId
        ? await database
            .select({ session: analyticsSessions })
            .from(analyticsDatasetSessions)
            .innerJoin(
              analyticsSessions,
              eq(analyticsDatasetSessions.sessionId, analyticsSessions.id),
            )
            .where(eq(analyticsDatasetSessions.datasetId, datasetId))
        : await database
            .select({ session: analyticsSessions })
            .from(analyticsSessions)
            .orderBy(desc(analyticsSessions.startedAt))
            .limit(500);
      const [run] = claimedRunId
        ? await database
            .select()
            .from(analyticsEvalRuns)
            .where(
              and(
                eq(analyticsEvalRuns.id, claimedRunId),
                eq(analyticsEvalRuns.evaluatorId, evaluatorId),
                eq(analyticsEvalRuns.status, "running"),
              ),
            )
            .limit(1)
        : await database
            .insert(analyticsEvalRuns)
            .values({
              evaluatorId,
              evaluatorVersion: evaluator.activeVersion,
              datasetId: datasetId ?? null,
              calibration,
              status: "running",
              startedAt: new Date(),
              createdBy: actorUserId,
            })
            .returning();
      if (!run) throw new Error("Evaluation run was not created.");
      const scores = await Promise.all(
        sessionRows.map(async ({ session }) => {
          const properties = session.properties as Record<string, unknown>;
          const humanWait = Number(properties.humanWaitMs ?? 0);
          const toolCalls = Number(properties.toolCalls ?? 0);
          let explanation = `${definition.signal ?? "code"} score`;
          let score =
            definition.signal === "task_completion"
              ? session.taskCompleted === true
                ? 100
                : 0
              : definition.signal === "helpfulness"
                ? session.negativeFeedback
                  ? 0
                  : session.taskCompleted === true
                    ? 100
                    : 50
                : Math.max(
                    0,
                    100 -
                      (session.technicalFailure ? 50 : 0) -
                      (session.toolFailure ? 30 : 0) -
                      Math.min(
                        20,
                        humanWait / 1_000 + Math.max(0, toolCalls - 5),
                      ),
                  );
          if (evaluator.kind === "llm_judge") {
            if (!llmJudge) throw new Error("The LLM judge is not configured.");
            const judged = JSON.parse(
              await llmJudge(
                `Return one JSON object with numeric score from 0 to 100 and a short explanation.\nRubric: ${JSON.stringify(definition)}\nPrivacy-safe session: ${JSON.stringify({ intent: session.intent, summary: session.summary, status: session.status, taskCompleted: session.taskCompleted, technicalFailure: session.technicalFailure, toolFailure: session.toolFailure })}`,
              ),
            ) as { score?: unknown; explanation?: unknown };
            if (
              typeof judged.score !== "number" ||
              !Number.isFinite(judged.score)
            ) {
              throw new Error("The LLM judge returned no finite score.");
            }
            score = Math.max(0, Math.min(100, judged.score));
            explanation =
              typeof judged.explanation === "string"
                ? judged.explanation.slice(0, 2_000)
                : "LLM judge score";
          }
          return {
            sessionId: session.id,
            score: Math.round(score),
            explanation,
          };
        }),
      );
      const threshold = definition.threshold ?? 70;
      await database.transaction(async (tx) => {
        if (scores.length > 0) {
          await tx.insert(analyticsEvalResults).values(
            scores.map((result) => ({
              runId: run.id,
              sessionId: result.sessionId,
              numericScore: result.score,
              passed: result.score >= threshold,
              explanation: result.explanation,
              evidence: { evaluatorVersion: evaluator.activeVersion },
            })),
          );
        }
        const aggregate =
          scores.length === 0
            ? 0
            : Math.round(
                scores.reduce((sum, item) => sum + item.score, 0) /
                  scores.length,
              );
        const previous = await tx
          .select({ aggregateScore: analyticsEvalRuns.aggregateScore })
          .from(analyticsEvalRuns)
          .where(
            and(
              eq(analyticsEvalRuns.evaluatorId, evaluatorId),
              eq(analyticsEvalRuns.status, "completed"),
            ),
          )
          .orderBy(desc(analyticsEvalRuns.finishedAt))
          .limit(1);
        const baseline = previous[0]?.aggregateScore ?? null;
        const regression = baseline !== null && aggregate < baseline - 10;
        await tx
          .update(analyticsEvalRuns)
          .set({
            status: "completed",
            aggregateScore: aggregate,
            baselineScore: baseline,
            regression,
            finishedAt: new Date(),
          })
          .where(eq(analyticsEvalRuns.id, run.id));
        if (regression && scores[0]) {
          await tx.insert(analyticsEvents).values({
            sessionId: scores[0].sessionId,
            source: "openbot-evaluator",
            idempotencyKey: `regression:${run.id}`,
            eventType: "analytics.evaluator.regression",
            name: `${evaluator.name} regressed`,
            userId: actorUserId,
            success: false,
            properties: { evaluatorId, runId: run.id, baseline, aggregate },
          });
        }
      });
      return { runId: run.id, sessions: scores.length };
    },

    async runScheduledEvaluators(actorUserId = "analytics-scheduler") {
      const active = await database
        .select({
          id: analyticsEvaluators.id,
          activeVersion: analyticsEvaluators.activeVersion,
        })
        .from(analyticsEvaluators)
        .where(eq(analyticsEvaluators.lifecycle, "active"));
      const ran: string[] = [];
      for (const evaluator of active) {
        const claimedRun = await database.transaction(async (tx) => {
          const lockKey = `openbot:analytics-evaluator:${evaluator.id}`;
          const lockResult = await tx.execute(
            sql`select pg_try_advisory_xact_lock(hashtext(${lockKey})) as acquired`,
          );
          const acquired = Boolean(
            (lockResult[0] as { acquired?: boolean } | undefined)?.acquired,
          );
          if (!acquired) return null;
          const [recent] = await tx
            .select({ createdAt: analyticsEvalRuns.createdAt })
            .from(analyticsEvalRuns)
            .where(eq(analyticsEvalRuns.evaluatorId, evaluator.id))
            .orderBy(desc(analyticsEvalRuns.createdAt))
            .limit(1);
          if (
            recent &&
            Date.now() - recent.createdAt.getTime() < 24 * 60 * 60_000
          ) {
            return null;
          }
          if (!evaluator.activeVersion) return null;
          const [run] = await tx
            .insert(analyticsEvalRuns)
            .values({
              evaluatorId: evaluator.id,
              evaluatorVersion: evaluator.activeVersion,
              calibration: false,
              status: "running",
              startedAt: new Date(),
              createdBy: actorUserId,
            })
            .returning({ id: analyticsEvalRuns.id });
          return run ?? null;
        });
        if (!claimedRun) continue;
        // The durable row is the cross-replica claim. Run only after releasing the transaction's
        // connection, so a one-connection deployment cannot deadlock itself here.
        await this.runEvaluator(
          actorUserId,
          evaluator.id,
          undefined,
          false,
          claimedRun.id,
        );
        ran.push(evaluator.id);
      }
      return ran;
    },

    async recordedEpisodes(limit = 200) {
      const rows = await database
        .select({ properties: analyticsEvents.properties })
        .from(analyticsEvents)
        .where(eq(analyticsEvents.eventType, "agent.verification.episode"))
        .orderBy(desc(analyticsEvents.occurredAt))
        .limit(Math.max(1, Math.min(2_000, Math.floor(limit))));
      return rows.flatMap((row) => {
        const properties = row.properties as Record<string, unknown>;
        const episode = properties.episode;
        return episode && typeof episode === "object" ? [{ episode }] : [];
      });
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
      const episode = {
        id: sessionId,
        taskId: "live-tool-execution",
        taskVersion: "2",
        agentVersion: session.agentId ?? "unknown",
        model: "runtime-selected",
        initialStateHash: createHash("sha256")
          .update(`${sessionId}:start`)
          .digest("hex"),
        finalStateHash: createHash("sha256")
          .update(
            JSON.stringify({
              observed: verdict.observed,
              matched: verdict.matched,
              rejected: verdict.rejected,
              failures: verdict.unresolvedOperationalFailures,
            }),
          )
          .digest("hex"),
        verifierResults: [
          {
            id: "tool-execution-integrity",
            version: "2",
            passed:
              verdict.passed &&
              verdict.unresolvedOperationalFailures.length === 0,
            score:
              verdict.observed.length === 0
                ? 0
                : verdict.matched.length / verdict.observed.length,
            critical: true,
            evidence: { auditEventIds: verdict.auditEventIds },
          },
        ],
        reward: {
          taskCorrectness: verdict.passed ? 1 : 0,
          policyCompliance: verdict.unmatched.length === 0 ? 1 : 0,
          unsupportedClaims: verdict.unmatched.length,
          unnecessaryToolCalls: 0,
          humanInterventions: 0,
          costUsd: 0,
          latencyMs: 0,
        },
        terminatedBecause: verdict.passed
          ? ("success" as const)
          : ("failure" as const),
      };
      const episodeScore = scoreEpisode(episode);

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
          .insert(analyticsEvents)
          .values({
            sessionId,
            source: "openbot-verifier",
            idempotencyKey: `${sessionId}:verifiable-episode:v1`,
            eventType: "agent.verification.episode",
            name: "Verifiable reward episode",
            userId: actorUserId,
            agentId: session.agentId,
            success: episodeScore.eligibleForTraining,
            properties: {
              taskId: episode.taskId,
              taskVersion: episode.taskVersion,
              eligibleForTraining: episodeScore.eligibleForTraining,
              scalarReward: episodeScore.scalarReward,
              reasons: episodeScore.reasons,
              verifiers: episode.verifierResults.map((result) => ({
                id: result.id,
                version: result.version,
                passed: result.passed,
                score: result.score,
                critical: result.critical,
              })),
              initialStateHash: episode.initialStateHash,
              finalStateHash: episode.finalStateHash,
            },
            occurredAt,
          })
          .onConflictDoUpdate({
            target: [analyticsEvents.source, analyticsEvents.idempotencyKey],
            set: {
              success: episodeScore.eligibleForTraining,
              properties: {
                taskId: episode.taskId,
                taskVersion: episode.taskVersion,
                eligibleForTraining: episodeScore.eligibleForTraining,
                scalarReward: episodeScore.scalarReward,
                reasons: episodeScore.reasons,
                verifiers: episode.verifierResults.map((result) => ({
                  id: result.id,
                  version: result.version,
                  passed: result.passed,
                  score: result.score,
                  critical: result.critical,
                })),
                initialStateHash: episode.initialStateHash,
                finalStateHash: episode.finalStateHash,
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
