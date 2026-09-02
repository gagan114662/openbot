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
