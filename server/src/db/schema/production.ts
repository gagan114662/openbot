import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
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
