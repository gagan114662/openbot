import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  analyticsSessions,
  auditEvents,
  productionInvestigations,
  productionIssues,
  productionMonitors,
} from "../db/schema";
import type { ContextGraph } from "../software-factory/context-graph";
import { executionTiers } from "../software-factory/model-router";
import { managedJobKinds } from "../software-factory/orchestrator";

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const emittedMonitorMetrics = [
  "openbot_agent_failures_total",
  "openbot_codex_run_errors_total",
  "openbot_tool_failures_total",
] as const;

function pendingThreshold(proposal: Record<string, unknown>) {
  if (
    proposal.requiresApproval !== true ||
    typeof proposal.proposedThreshold !== "number" ||
    !Number.isFinite(proposal.proposedThreshold) ||
    proposal.proposedThreshold <= 0
  ) {
    throw new Error("No administrator-approved threshold change is pending.");
  }
  return proposal.proposedThreshold;
}

export type FixDrafter = (input: {
  issueId: string;
  title: string;
  rootCause: string;
  evidence: unknown;
}) => Promise<{
  branch: string;
  pullRequestUrl: string;
  debt?: ProductionDebtAssessment;
}>;

export type ProductionDebtAssessment = {
  metrics: {
    addedDependencies: number;
    complexityPoints: number;
    duplicatedLines: number;
    maximumFileLines: number;
  };
  budget: {
    addedDependencies: number;
    complexityPoints: number;
    duplicatedLines: number;
    maximumFileLines: number;
  };
  changedPaths: string[];
  violations: string[];
};

export class TechnicalDebtGateError extends Error {
  constructor(readonly debt: ProductionDebtAssessment) {
    super(`Technical-debt review required: ${debt.violations.join("; ")}`);
    this.name = "TechnicalDebtGateError";
  }
}

export function monitorForChange(intent: string, path: string) {
  const change = `${intent} ${path}`;
  if (/analytics|eval|quality|regression/i.test(change))
    return {
      key: "analytics-failure-rate",
      title: "Agent analytics failures",
      expression: "openbot_agent_failures_total",
      threshold: 5,
    };
  if (/agent-codex|copilot|agent run|model|codex/i.test(change))
    return {
      key: "agent-run-errors",
      title: "Agent run errors",
      expression: "openbot_codex_run_errors_total",
      threshold: 3,
    };
  if (/plugins|mcp|tool|connector|integration/i.test(change))
    return {
      key: "tool-call-failures",
      title: "Tool call failures",
      expression: "openbot_tool_failures_total",
      threshold: 3,
    };
  return {
    key: "analytics-failure-rate",
    title: "Agent analytics failures",
    expression: "openbot_agent_failures_total",
    threshold: 5,
  };
}

export function createProductionEngineerStore(
  database: Database,
  fixDrafter?: FixDrafter,
  auditStore?: AuditStore,
  recordDebtAssessment?: (input: {
    issueId: string;
    actorId: string;
    debt: ProductionDebtAssessment;
  }) => Promise<void>,
  factory?: { contextGraph: ContextGraph; tenantId: string },
) {
  return {
    async prometheusMetrics() {
      const [[agentFailures], [toolFailures], [sessions]] = await Promise.all([
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(analyticsSessions)
          .where(
            or(
              eq(analyticsSessions.technicalFailure, true),
              eq(analyticsSessions.toolFailure, true),
            ),
          ),
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(auditEvents)
          .where(eq(auditEvents.eventType, "mcp.call_failed")),
        database
          .select({ count: sql<number>`count(*)::int` })
          .from(analyticsSessions),
      ]);
      return [
        "# TYPE openbot_agent_failures_total counter",
        `openbot_agent_failures_total ${agentFailures?.count ?? 0}`,
        "# TYPE openbot_tool_failures_total counter",
        `openbot_tool_failures_total ${toolFailures?.count ?? 0}`,
        "# TYPE openbot_analytics_sessions_total counter",
        `openbot_analytics_sessions_total ${sessions?.count ?? 0}`,
        "",
      ].join("\n");
    },
    async dashboard() {
      const [monitors, issues, investigations, contextGraph] =
        await Promise.all([
          database
            .select()
            .from(productionMonitors)
            .where(
              inArray(productionMonitors.expression, emittedMonitorMetrics),
            )
            .orderBy(productionMonitors.title),
          database
            .select()
            .from(productionIssues)
            .orderBy(desc(productionIssues.updatedAt))
            .limit(200),
          database
            .select()
            .from(productionInvestigations)
            .orderBy(desc(productionInvestigations.createdAt))
            .limit(200),
          factory?.contextGraph.stats(factory.tenantId) ??
            Promise.resolve({ nodes: 0, edges: 0, sourceSystems: 0 }),
        ]);
      return {
        monitors,
        issues,
        investigations,
        fixAutomationEnabled: Boolean(fixDrafter),
        factory: {
          executionTiers,
          managedJobKinds,
          modelRouting: "benchmark-pareto-cost-per-outcome",
          workerPattern: "judging-orchestrator-bounded-workers",
          contextGraph,
        },
      };
    },

    async prometheusRules() {
      const monitors = await database
        .select()
        .from(productionMonitors)
        .where(
          and(
            eq(productionMonitors.active, true),
            inArray(productionMonitors.expression, emittedMonitorMetrics),
          ),
        )
        .orderBy(productionMonitors.key);
      const quoted = (value: string) => JSON.stringify(value);
      return [
        "groups:",
        "  - name: openbot-generated",
        "    rules:",
        ...monitors.flatMap((monitor) => [
          `      - alert: ${monitor.key.replace(/[^a-zA-Z0-9_]/g, "_")}`,
          `        expr: increase(${monitor.expression}[15m]) >= ${monitor.threshold}`,
          "        for: 5m",
          "        labels:",
          "          severity: warning",
          `          monitor_key: ${quoted(monitor.key)}`,
          "        annotations:",
          `          summary: ${quoted(monitor.title)}`,
          `          intent: ${quoted(monitor.intent)}`,
          '          openbot_value: "{{ $value }}"',
        ]),
        "",
      ].join("\n");
    },

    async monitorsFromMerge(
      actorId: string,
      input: {
        pullRequest: string;
        intent: string;
        changedPaths: string[];
        deployedAt?: string;
      },
    ) {
      const monitors = [
        ...new Map(
          input.changedPaths.map((path) => {
            const monitor = monitorForChange(input.intent, path);
            return [monitor.key, monitor] as const;
          }),
        ).values(),
      ];
      for (const monitor of monitors) {
        const [baseline] =
          monitor.key === "tool-call-failures"
            ? await database
                .select({ value: sql<number>`count(*)::int` })
                .from(auditEvents)
                .where(eq(auditEvents.eventType, "mcp.call_failed"))
            : await database
                .select({ value: sql<number>`count(*)::int` })
                .from(analyticsSessions)
                .where(
                  or(
                    eq(analyticsSessions.technicalFailure, true),
                    eq(analyticsSessions.toolFailure, true),
                  ),
                );
        await database
          .insert(productionMonitors)
          .values({
            ...monitor,
            intent: `${input.intent} (${input.pullRequest})`,
            baseline: baseline?.value ?? 0,
            createdBy: actorId,
          })
          .onConflictDoUpdate({
            target: productionMonitors.key,
            set: {
              title: monitor.title,
              intent: `${input.intent} (${input.pullRequest})`,
              expression: monitor.expression,
              threshold: monitor.threshold,
              baseline: baseline?.value ?? 0,
              active: true,
              updatedAt: new Date(),
            },
          });
      }
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "production.deployment_observed",
          targetType: "pull_request",
          targetId: input.pullRequest,
          actorUserId: actorId,
          payload: {
            intent: input.intent,
            changedPathCount: input.changedPaths.length,
            deployedAt: input.deployedAt ?? null,
            monitorKeys: monitors.map((monitor) => monitor.key),
          },
        });
      }
      return { createdOrUpdated: monitors.length, monitors };
    },

    async triageAlert(
      actorId: string,
      input: {
        monitorKey: string;
        value: number;
        labels?: Record<string, string>;
        firedAt?: string;
      },
    ) {
      const [monitor] = await database
        .select()
        .from(productionMonitors)
        .where(eq(productionMonitors.key, input.monitorKey))
        .limit(1);
      if (!monitor) throw new Error("Monitor not found.");
      const firedAt = new Date(input.firedAt ?? Date.now());
      const recent = await database
        .select({
          id: auditEvents.id,
          eventType: auditEvents.eventType,
          targetId: auditEvents.targetId,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          gte(auditEvents.createdAt, new Date(firedAt.getTime() - 60 * 60_000)),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(25);
      const reviewedLearning = await database
        .select({
          summary: productionInvestigations.summary,
          outcome: productionInvestigations.outcome,
        })
        .from(productionInvestigations)
        .where(eq(productionInvestigations.approved, true))
        .orderBy(desc(productionInvestigations.createdAt))
        .limit(100);
      const alertTerms = new Set(
        `${monitor.title} ${monitor.intent} ${JSON.stringify(input.labels ?? {})}`
          .toLowerCase()
          .match(/[a-z0-9]{4,}/g) ?? [],
      );
      const relevantLearning = reviewedLearning
        .map((entry) => ({
          ...entry,
          relevance: (
            `${entry.summary} ${entry.outcome}`
              .toLowerCase()
              .match(/[a-z0-9]{4,}/g) ?? []
          ).filter((term) => alertTerms.has(term)).length,
        }))
        .filter((entry) => entry.relevance > 0)
        .sort((left, right) => right.relevance - left.relevance);
      const genuine = input.value >= monitor.threshold;
      const likelyChange = recent.find((event) =>
        [
          "configuration.changed",
          "agent.evolution_promoted",
          "operations.restore_drill_verified",
          "production.deployment_observed",
        ].includes(event.eventType),
      );
      const deviation = Math.round(
        ((input.value - monitor.threshold) / monitor.threshold) * 100,
      );
      const labelEvidence = Object.entries(input.labels ?? {})
        .slice(0, 8)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      const rootCauseBase = genuine
        ? likelyChange
          ? `The signal is ${deviation}% above threshold ${monitor.threshold} after ${likelyChange.eventType} on ${likelyChange.targetId}.${labelEvidence ? ` Alert labels: ${labelEvidence}.` : ""}`
          : `The signal is ${deviation}% above threshold ${monitor.threshold}; no correlated deployment/configuration audit row was found in the prior hour.${labelEvidence ? ` Alert labels: ${labelEvidence}.` : ""}`
        : `The signal remained below the configured threshold ${monitor.threshold}.`;
      const rootCause =
        relevantLearning.length > 0
          ? `${rootCauseBase} Relevant reviewed precedent: ${relevantLearning[0]?.summary} Outcome: ${relevantLearning[0]?.outcome}`
          : rootCauseBase;
      await database
        .update(productionMonitors)
        .set({
          firingCount: sql`${productionMonitors.firingCount} + 1`,
          ...(!genuine
            ? {
                falsePositiveCount: sql`${productionMonitors.falsePositiveCount} + 1`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(productionMonitors.id, monitor.id));
      if (!genuine) return { genuine: false, rootCause };
      const issueFingerprint = fingerprint({
        monitor: monitor.id,
        labels: input.labels ?? {},
      });
      const [issue] = await database
        .insert(productionIssues)
        .values({
          monitorId: monitor.id,
          fingerprint: issueFingerprint,
          title: monitor.title,
          severity: input.value >= monitor.threshold * 2 ? "high" : "medium",
          rootCause,
          recentDeploy: likelyChange ?? {},
          evidence: {
            value: input.value,
            threshold: monitor.threshold,
            labels: input.labels ?? {},
            auditEventIds: recent.map((event) => event.id),
          },
        })
        .onConflictDoUpdate({
          target: productionIssues.fingerprint,
          set: {
            rootCause,
            evidence: {
              value: input.value,
              threshold: monitor.threshold,
              labels: input.labels ?? {},
              auditEventIds: recent.map((event) => event.id),
            },
            updatedAt: new Date(),
          },
        })
        .returning();
      if (issue && auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "agent.escalated",
          targetType: "production_issue",
          targetId: issue.id,
          actorUserId: actorId,
          payload: {
            issue: issue.id,
            monitor: monitor.key,
            reason: rootCause,
            reached: "the production on-call queue",
          },
        });
      }
      return { genuine: true, issue, rootCause, escalatedBy: actorId };
    },

    async proposeTuning(monitorId: string) {
      const [monitor] = await database
        .select()
        .from(productionMonitors)
        .where(eq(productionMonitors.id, monitorId))
        .limit(1);
      if (!monitor) throw new Error("Monitor not found.");
      const rate =
        monitor.firingCount === 0
          ? 0
          : monitor.falsePositiveCount / monitor.firingCount;
      const proposal =
        rate >= 0.3
          ? {
              currentThreshold: monitor.threshold,
              proposedThreshold: Math.max(
                monitor.threshold + 1,
                Math.ceil(monitor.threshold * 1.25),
              ),
              reason: `${Math.round(rate * 100)}% of firings were marked noise`,
              requiresApproval: true,
            }
          : {
              currentThreshold: monitor.threshold,
              proposedThreshold: monitor.threshold,
              reason: "Observed flappiness is below 30%",
              requiresApproval: false,
            };
      await database
        .update(productionMonitors)
        .set({ tuningProposal: proposal, updatedAt: new Date() })
        .where(eq(productionMonitors.id, monitorId));
      return proposal;
    },

    async applyTuning(actorId: string, monitorId: string) {
      const applied = await database.transaction(async (transaction) => {
        const [monitor] = await transaction
          .select()
          .from(productionMonitors)
          .where(eq(productionMonitors.id, monitorId))
          .limit(1)
          .for("update");
        if (!monitor) throw new Error("Monitor not found.");
        const proposal = monitor.tuningProposal as Record<string, unknown>;
        const proposedThreshold = pendingThreshold(proposal);
        await transaction
          .update(productionMonitors)
          .set({
            threshold: proposedThreshold,
            tuningProposal: {},
            updatedAt: new Date(),
          })
          .where(eq(productionMonitors.id, monitorId));
        return { monitor, proposal, proposedThreshold };
      });
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "production_monitor",
          targetId: monitorId,
          actorUserId: actorId,
          payload: {
            setting: "threshold",
            previousThreshold: applied.monitor.threshold,
            proposedThreshold: applied.proposedThreshold,
            reason: applied.proposal.reason,
          },
        });
      }
      return {
        monitorId,
        previousThreshold: applied.monitor.threshold,
        threshold: applied.proposedThreshold,
      };
    },

    async rejectTuning(actorId: string, monitorId: string) {
      const rejected = await database.transaction(async (transaction) => {
        const [monitor] = await transaction
          .select()
          .from(productionMonitors)
          .where(eq(productionMonitors.id, monitorId))
          .limit(1)
          .for("update");
        if (!monitor) throw new Error("Monitor not found.");
        const proposal = monitor.tuningProposal as Record<string, unknown>;
        const proposedThreshold = pendingThreshold(proposal);
        await transaction
          .update(productionMonitors)
          .set({ tuningProposal: {}, updatedAt: new Date() })
          .where(eq(productionMonitors.id, monitorId));
        return { monitor, proposal, proposedThreshold };
      });
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "production.tuning_rejected",
          targetType: "production_monitor",
          targetId: monitorId,
          actorUserId: actorId,
          payload: {
            retainedThreshold: rejected.monitor.threshold,
            rejectedThreshold: rejected.proposedThreshold,
            reason: rejected.proposal.reason,
          },
        });
      }
      return {
        monitorId,
        threshold: rejected.monitor.threshold,
        rejectedThreshold: rejected.proposedThreshold,
      };
    },

    async draftFix(actorId: string, issueId: string) {
      if (!fixDrafter)
        throw new Error("Fix automation is disabled for this deployment.");
      const [issue] = await database
        .select()
        .from(productionIssues)
        .where(
          and(
            eq(productionIssues.id, issueId),
            eq(productionIssues.status, "open"),
          ),
        )
        .limit(1);
      if (!issue) throw new Error("Open production issue not found.");
      await database
        .update(productionIssues)
        .set({
          fixStatus: "running",
          humanApprovedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(productionIssues.id, issueId));
      try {
        const drafted = await fixDrafter({
          issueId,
          title: issue.title,
          rootCause: issue.rootCause,
          evidence: issue.evidence,
        });
        if (drafted.debt && recordDebtAssessment) {
          await recordDebtAssessment({ issueId, actorId, debt: drafted.debt });
        }
        await database
          .update(productionIssues)
          .set({
            fixStatus: "pull_request_open",
            fixBranch: drafted.branch,
            pullRequestUrl: drafted.pullRequestUrl,
            updatedAt: new Date(),
          })
          .where(eq(productionIssues.id, issueId));
        return drafted;
      } catch (error) {
        if (error instanceof TechnicalDebtGateError && recordDebtAssessment) {
          await recordDebtAssessment({ issueId, actorId, debt: error.debt });
        }
        await database
          .update(productionIssues)
          .set({
            fixStatus:
              error instanceof TechnicalDebtGateError
                ? "review_required"
                : "failed",
            updatedAt: new Date(),
          })
          .where(eq(productionIssues.id, issueId));
        throw error;
      }
    },

    async recordInvestigation(
      actorId: string,
      issueId: string,
      input: { summary: string; outcome: string; approved: boolean },
    ) {
      const [entry] = await database
        .insert(productionInvestigations)
        .values({
          issueId,
          summary: input.summary,
          outcome: input.outcome,
          approved: input.approved,
          approvedBy: input.approved ? actorId : null,
          createdBy: actorId,
        })
        .returning();
      return entry;
    },

    async setIssueStatus(actorId: string, issueId: string, status: string) {
      if (!new Set(["open", "resolved", "dismissed"]).has(status))
        throw new Error("Issue status is invalid.");
      const [issue] = await database
        .update(productionIssues)
        .set({ status, updatedAt: new Date() })
        .where(eq(productionIssues.id, issueId))
        .returning();
      if (!issue) throw new Error("Production issue not found.");
      if (auditStore)
        await recordAuditEvent(auditStore, {
          eventType: "production.issue_status_changed",
          targetType: "production_issue",
          targetId: issueId,
          actorUserId: actorId,
          payload: { status },
        });
      return issue;
    },
  };
}

export type ProductionEngineerStore = ReturnType<
  typeof createProductionEngineerStore
>;
