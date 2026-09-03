import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const analyticsPrivacyMode = pgEnum("analytics_privacy_mode", [
  "full",
  "metadata_only",
  "customer_enriched",
]);
export const analyticsSessionStatus = pgEnum("analytics_session_status", [
  "running",
  "completed",
  "failed",
  "abandoned",
]);
export const analyticsSpanKind = pgEnum("analytics_span_kind", [
  "agent",
  "llm",
  "tool",
  "retrieval",
  "product",
]);
export const analyticsEvaluatorKind = pgEnum("analytics_evaluator_kind", [
  "code",
  "llm_judge",
]);
export const analyticsScoreType = pgEnum("analytics_score_type", [
  "binary",
  "categorical",
  "numeric",
]);
export const analyticsLifecycle = pgEnum("analytics_lifecycle", [
  "draft",
  "active",
  "archived",
]);
export const analyticsRunStatus = pgEnum("analytics_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);
export const analyticsPermission = pgEnum("analytics_permission", [
  "view",
  "manage_evals",
  "activate_evals",
]);

export const analyticsSessions = pgTable(
  "analytics_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    source: text("source").notNull(),
    privacyMode: analyticsPrivacyMode("privacy_mode")
      .notNull()
      .default("metadata_only"),
    status: analyticsSessionStatus("status").notNull().default("running"),
    intent: text("intent"),
    summary: text("summary"),
    replayId: text("replay_id"),
    replayUrl: text("replay_url"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    experimentKey: text("experiment_key"),
    experimentVariant: text("experiment_variant"),
    taskCompleted: boolean("task_completed"),
    technicalFailure: boolean("technical_failure").notNull().default(false),
    toolFailure: boolean("tool_failure").notNull().default(false),
    negativeFeedback: boolean("negative_feedback").notNull().default(false),
    totalTokens: bigint("total_tokens", { mode: "number" })
      .notNull()
      .default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms"),
    properties: jsonb("properties").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("analytics_sessions_started_idx").on(table.startedAt),
    index("analytics_sessions_agent_started_idx").on(
      table.agentId,
      table.startedAt,
    ),
    index("analytics_sessions_user_started_idx").on(
      table.userId,
      table.startedAt,
    ),
    index("analytics_sessions_status_started_idx").on(
      table.status,
      table.startedAt,
    ),
  ],
);

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    name: text("name").notNull(),
    content: text("content"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    replayId: text("replay_id"),
    latencyMs: integer("latency_ms"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    costMicros: bigint("cost_micros", { mode: "number" }),
    success: boolean("success"),
    errorType: text("error_type"),
    properties: jsonb("properties").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("analytics_events_source_idempotency_idx").on(
      table.source,
      table.idempotencyKey,
    ),
    index("analytics_events_session_occurred_idx").on(
      table.sessionId,
      table.occurredAt,
    ),
    index("analytics_events_type_occurred_idx").on(
      table.eventType,
      table.occurredAt,
    ),
  ],
);

export const analyticsSpans = pgTable(
  "analytics_spans",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => analyticsEvents.id, {
      onDelete: "set null",
    }),
    parentSpanId: text("parent_span_id"),
    traceId: text("trace_id").notNull(),
    kind: analyticsSpanKind("kind").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    input: text("input"),
    output: text("output"),
    model: text("model"),
    toolName: text("tool_name"),
    latencyMs: integer("latency_ms"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    costMicros: bigint("cost_micros", { mode: "number" }),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("analytics_spans_session_started_idx").on(
      table.sessionId,
      table.startedAt,
    ),
  ],
);

export const analyticsFeedback = pgTable("analytics_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id")
    .notNull()
    .references(() => analyticsSessions.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").references(() => analyticsEvents.id, {
    onDelete: "set null",
  }),
  userId: text("user_id"),
  rating: integer("rating"),
  negative: boolean("negative").notNull().default(false),
  category: text("category"),
  note: text("note"),
  createdAt: createdAt(),
});

export const analyticsEvaluators = pgTable("analytics_evaluators", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  kind: analyticsEvaluatorKind("kind").notNull(),
  scoreType: analyticsScoreType("score_type").notNull(),
  lifecycle: analyticsLifecycle("lifecycle").notNull().default("draft"),
  activeVersion: integer("active_version"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const analyticsEvaluatorVersions = pgTable(
  "analytics_evaluator_versions",
  {
    evaluatorId: uuid("evaluator_id")
      .notNull()
      .references(() => analyticsEvaluators.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.evaluatorId, table.version] })],
);

export const analyticsDatasets = pgTable("analytics_datasets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  query: jsonb("query").notNull().default(sql`'{}'::jsonb`),
  golden: boolean("golden").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const analyticsDatasetSessions = pgTable(
  "analytics_dataset_sessions",
  {
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => analyticsDatasets.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    addedBy: text("added_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.datasetId, table.sessionId] })],
);

export const analyticsEvalRuns = pgTable("analytics_eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  evaluatorId: uuid("evaluator_id")
    .notNull()
    .references(() => analyticsEvaluators.id, { onDelete: "cascade" }),
  evaluatorVersion: integer("evaluator_version").notNull(),
  datasetId: uuid("dataset_id").references(() => analyticsDatasets.id, {
    onDelete: "set null",
  }),
  calibration: boolean("calibration").notNull().default(false),
  status: analyticsRunStatus("status").notNull().default("queued"),
  baselineScore: integer("baseline_score"),
  aggregateScore: integer("aggregate_score"),
  regression: boolean("regression").notNull().default(false),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const analyticsEvalResults = pgTable(
  "analytics_eval_results",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => analyticsEvalRuns.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    numericScore: integer("numeric_score"),
    category: text("category"),
    passed: boolean("passed"),
    explanation: text("explanation"),
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.sessionId] })],
);

export const analyticsReviews = pgTable("analytics_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: text("session_id")
    .notNull()
    .references(() => analyticsSessions.id, { onDelete: "cascade" }),
  datasetId: uuid("dataset_id").references(() => analyticsDatasets.id, {
    onDelete: "set null",
  }),
  reviewerId: text("reviewer_id").notNull(),
  status: text("status").notNull().default("pending"),
  label: text("label"),
  errorCategory: text("error_category"),
  note: text("note"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const analyticsTopics = pgTable("analytics_topics", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const analyticsSessionTopics = pgTable(
  "analytics_session_topics",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => analyticsTopics.id, { onDelete: "cascade" }),
    confidence: integer("confidence").notNull(),
    source: text("source").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.topicId] })],
);

export const analyticsPermissions = pgTable(
  "analytics_permissions",
  {
    userId: text("user_id").notNull(),
    permission: analyticsPermission("permission").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.permission] })],
);
