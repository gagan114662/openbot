import {
  boolean,
  index,
  integer,
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

export const productionMonitors = pgTable("production_monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  intent: text("intent").notNull(),
  expression: text("expression").notNull(),
  threshold: integer("threshold").notNull(),
  baseline: integer("baseline"),
  firingCount: integer("firing_count").notNull().default(0),
  falsePositiveCount: integer("false_positive_count").notNull().default(0),
  tuningProposal: jsonb("tuning_proposal").notNull().default({}),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const productionIssues = pgTable(
  "production_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id").references(() => productionMonitors.id, {
      onDelete: "set null",
    }),
    fingerprint: text("fingerprint").notNull().unique(),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    severity: text("severity").notNull(),
    rootCause: text("root_cause").notNull().default(""),
    recentDeploy: jsonb("recent_deploy").notNull().default({}),
    evidence: jsonb("evidence").notNull().default({}),
    fixStatus: text("fix_status").notNull().default("none"),
    fixBranch: text("fix_branch"),
    pullRequestUrl: text("pull_request_url"),
    humanApprovedBy: text("human_approved_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("production_issues_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const productionInvestigations = pgTable("production_investigations", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id")
    .notNull()
    .references(() => productionIssues.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  outcome: text("outcome").notNull(),
  approved: boolean("approved").notNull().default(false),
  approvedBy: text("approved_by"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const factoryContextNodes = pgTable(
  "factory_context_nodes",
  {
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    value: text("value").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceUrl: text("source_url"),
    checksum: text("checksum").notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.key] }),
    index("factory_context_nodes_tenant_kind_idx").on(
      table.tenantId,
      table.kind,
    ),
  ],
);

export const factoryContextEdges = pgTable(
  "factory_context_edges",
  {
    tenantId: text("tenant_id").notNull(),
    fromKey: text("from_key").notNull(),
    toKey: text("to_key").notNull(),
    relation: text("relation").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.fromKey, table.toKey, table.relation],
    }),
    index("factory_context_edges_from_idx").on(table.tenantId, table.fromKey),
    index("factory_context_edges_to_idx").on(table.tenantId, table.toKey),
  ],
);

export const factoryModelBenchmarks = pgTable(
  "factory_model_benchmarks",
  {
    tenantId: text("tenant_id").notNull(),
    model: text("model").notNull(),
    task: text("task").notNull(),
    qualityBasisPoints: integer("quality_basis_points").notNull(),
    successfulOutcomes: integer("successful_outcomes").notNull().default(0),
    attemptedOutcomes: integer("attempted_outcomes").notNull().default(0),
    totalCostMicros: integer("total_cost_micros").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.model, table.task] }),
  ],
);

export const factoryManagedJobs = pgTable(
  "factory_managed_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    tier: text("tier").notNull(),
    objective: text("objective").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("queued"),
    selectedModel: text("selected_model"),
    outcome: jsonb("outcome").notNull().default({}),
    costMicros: integer("cost_micros").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("factory_managed_jobs_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const reconciledWebhookEvents = pgTable(
  "reconciled_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    aggregateKey: text("aggregate_key").notNull(),
    sequence: integer("sequence").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("reconciled_webhooks_event_uidx").on(
      table.tenantId,
      table.provider,
      table.eventId,
    ),
    index("reconciled_webhooks_ready_idx").on(
      table.tenantId,
      table.status,
      table.availableAt,
    ),
    index("reconciled_webhooks_aggregate_idx").on(
      table.tenantId,
      table.provider,
      table.aggregateKey,
      table.sequence,
    ),
  ],
);

export const shadowEvaluations = pgTable(
  "shadow_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    requestKey: text("request_key").notNull(),
    primaryModel: text("primary_model").notNull(),
    shadowModel: text("shadow_model").notNull(),
    primaryOutputHash: text("primary_output_hash").notNull(),
    shadowOutputHash: text("shadow_output_hash").notNull(),
    agreementBasisPoints: integer("agreement_basis_points").notNull(),
    shadowLatencyMs: integer("shadow_latency_ms").notNull(),
    status: text("status").notNull().default("completed"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("shadow_evaluations_request_uidx").on(
      table.tenantId,
      table.requestKey,
      table.shadowModel,
    ),
    index("shadow_evaluations_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const factoryWorkflowRuns = pgTable(
  "factory_workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => factoryManagedJobs.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    maximumAttempts: integer("maximum_attempts").notNull(),
    concurrencyLimit: integer("concurrency_limit").notNull(),
    steering: jsonb("steering").notNull().default({ events: [] }),
    pauseRequested: boolean("pause_requested").notNull().default(false),
    abortRequested: boolean("abort_requested").notNull().default(false),
    approvedBy: text("approved_by"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("factory_workflow_runs_job_uidx").on(
      table.tenantId,
      table.jobId,
    ),
    index("factory_workflow_runs_ready_idx").on(
      table.tenantId,
      table.status,
      table.leaseExpiresAt,
    ),
  ],
);

export const factoryWorkflowStages = pgTable(
  "factory_workflow_stages",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => factoryWorkflowRuns.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    objective: text("objective").notNull(),
    requiredContext: jsonb("required_context").notNull().default({ keys: [] }),
    dependsOn: jsonb("depends_on").notNull().default({ ids: [] }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    sessionId: text("session_id"),
    reviewerSessionId: text("reviewer_session_id"),
    verification: jsonb("verification").notNull().default({}),
    output: jsonb("output").notNull().default({}),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stageId] }),
    index("factory_workflow_stages_status_idx").on(table.runId, table.status),
  ],
);

export const factoryWorkflowArtifacts = pgTable(
  "factory_workflow_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => factoryWorkflowRuns.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    kind: text("kind").notNull(),
    uri: text("uri").notNull(),
    content: text("content").notNull(),
    checksum: text("checksum").notNull(),
    revision: text("revision").notNull(),
    producerSessionId: text("producer_session_id").notNull(),
    command: text("command"),
    exitCode: integer("exit_code"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("factory_workflow_artifacts_identity_uidx").on(
      table.runId,
      table.stageId,
      table.kind,
      table.uri,
      table.checksum,
    ),
    index("factory_workflow_artifacts_run_idx").on(
      table.runId,
      table.createdAt,
    ),
  ],
);

export const contextCompactionArtifacts = pgTable(
  "context_compaction_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    checksum: text("checksum").notNull(),
    content: jsonb("content").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("context_compaction_artifact_run_checksum_uidx").on(
      table.tenantId,
      table.runId,
      table.checksum,
    ),
    index("context_compaction_artifact_thread_idx").on(
      table.tenantId,
      table.threadId,
      table.createdAt,
    ),
  ],
);
