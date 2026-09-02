import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  productionInvestigations,
  productionIssues,
  productionMonitors,
} from "../src/db/schema";
import {
  createProductionEngineerStore,
  monitorForChange,
  TechnicalDebtGateError,
} from "../src/production-engineer/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const marker = crypto.randomUUID();
const monitorKey = `agent-run-errors-${marker}`;
const store = createProductionEngineerStore(database);
const issueIds: string[] = [];

afterAll(async () => {
  if (issueIds.length > 0) {
    await database
      .delete(productionInvestigations)
      .where(inArray(productionInvestigations.issueId, issueIds));
    await database
      .delete(productionIssues)
      .where(inArray(productionIssues.id, issueIds));
  }
  await database
    .delete(productionMonitors)
    .where(eq(productionMonitors.key, monitorKey));
});

describe("persistent production engineer", () => {
  test("concurrent fix requests atomically claim one drafter", async () => {
    const [issue] = await database
      .insert(productionIssues)
      .values({
        fingerprint: `concurrent-fix-${crypto.randomUUID()}`,
        title: "One fix only",
        severity: "high",
        rootCause: "one production cause",
      })
      .returning();
    issueIds.push(issue!.id);
    let invocations = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrentStore = createProductionEngineerStore(
      database,
      async () => {
        invocations += 1;
        await held;
        return {
          branch: `openbot/production-${issue!.id.slice(0, 8)}`,
          pullRequestUrl: `https://example.test/pull/${issue!.id}`,
        };
      },
    );
    const first = concurrentStore.draftFix("admin-one", issue!.id);
    while (invocations === 0) await Bun.sleep(5);
    await expect(
      concurrentStore.draftFix("admin-two", issue!.id),
    ).rejects.toThrow("not open for a new fix");
    expect(invocations).toBe(1);
    release();
    await first;
    expect(invocations).toBe(1);
  });

  test("derives only emitted monitor metrics from change intent and paths", async () => {
    expect(
      monitorForChange("Reduce connector tool failures", "server/src/index.ts"),
    ).toMatchObject({
      key: "tool-call-failures",
      expression: "openbot_tool_failures_total",
    });
    expect(
      monitorForChange("Improve model execution", "README.md"),
    ).toMatchObject({
      key: "agent-run-errors",
      expression: "openbot_codex_run_errors_total",
    });
    const metrics = await store.prometheusMetrics();
    expect(metrics).toContain("openbot_agent_failures_total");
    expect(metrics).toContain("openbot_tool_failures_total");
    expect(metrics).not.toContain("openbot_http_errors_total");
  });
  test("refuses a debt-heavy generated fix and sends it to human review", async () => {
    const [issue] = await database
      .insert(productionIssues)
      .values({
        fingerprint: `debt-${marker}`,
        title: "Debt-heavy generated fix",
        severity: "medium",
        rootCause: "Generated change exceeded the maintainability budget.",
      })
      .returning();
    if (!issue) throw new Error("Debt proof issue was not created");
    issueIds.push(issue.id);
    const debt = {
      metrics: {
        addedDependencies: 1,
        complexityPoints: 2,
        duplicatedLines: 0,
        maximumFileLines: 20,
      },
      budget: {
        addedDependencies: 0,
        complexityPoints: 80,
        duplicatedLines: 20,
        maximumFileLines: 800,
      },
      changedPaths: ["package.json"],
      violations: ["addedDependencies 1 exceeds 0"],
    };
    const recorded: unknown[] = [];
    const gated = createProductionEngineerStore(
      database,
      async () => {
        throw new TechnicalDebtGateError(debt);
      },
      undefined,
      async (input) => {
        recorded.push(input);
      },
    );
    await expect(gated.draftFix("admin-proof", issue.id)).rejects.toThrow(
      "Technical-debt review required",
    );
    const [persisted] = await database
      .select()
      .from(productionIssues)
      .where(eq(productionIssues.id, issue.id));
    expect(persisted).toMatchObject({
      fixStatus: "review_required",
      humanApprovedBy: "admin-proof",
    });
    expect(recorded).toEqual([
      { issueId: issue.id, actorId: "admin-proof", debt },
    ]);
  });

  test("creates a monitor, triages a genuine alert, and learns only after review", async () => {
    await database.insert(productionMonitors).values({
      key: monitorKey,
      title: "Agent run errors",
      intent: "integration proof",
      expression: "openbot_codex_run_errors_total",
      threshold: 3,
      createdBy: "admin-proof",
    });
    const triage = await store.triageAlert("admin-proof", {
      monitorKey,
      value: 7,
      labels: { deployment: marker },
    });
    expect(triage.genuine).toBe(true);
    if (!triage.genuine || !triage.issue)
      throw new Error("Issue was not opened");
    issueIds.push(triage.issue.id);
    const memory = await store.recordInvestigation(
      "admin-proof",
      triage.issue.id,
      {
        summary: "The alert correlated with the failing adapter.",
        outcome: "Permit release was repaired.",
        approved: true,
      },
    );
    expect(memory).toMatchObject({ approved: true, approvedBy: "admin-proof" });
    await store.recordInvestigation("admin-proof", triage.issue.id, {
      summary: "Invoice export formatting",
      outcome: "Updated a customer template.",
      approved: true,
    });
    await store.recordInvestigation("admin-proof", triage.issue.id, {
      summary: `Agent run errors in deployment ${marker}`,
      outcome: "Released the adapter permit.",
      approved: true,
    });
    const learned = await store.triageAlert("admin-proof", {
      monitorKey,
      value: 8,
      labels: { deployment: marker, occurrence: "relevance-proof" },
    });
    expect(learned.rootCause).toContain(
      `Relevant reviewed precedent: Agent run errors in deployment ${marker}`,
    );
    expect(learned.rootCause).not.toContain("Invoice export formatting");
    const dashboard = await store.dashboard();
    expect(
      dashboard.issues.some((issue) => issue.id === triage.issue?.id),
    ).toBe(true);
    const proposal = await store.proposeTuning(
      dashboard.monitors.find((monitor) => monitor.key === monitorKey)?.id ??
        "",
    );
    expect(proposal).toMatchObject({
      currentThreshold: 3,
      proposedThreshold: 3,
      requiresApproval: false,
    });
    await store.triageAlert("admin-proof", {
      monitorKey,
      value: 1,
      labels: { deployment: `${marker}-noise-1` },
    });
    await store.triageAlert("admin-proof", {
      monitorKey,
      value: 1,
      labels: { deployment: `${marker}-noise-2` },
    });
    const noisyProposal = await store.proposeTuning(
      dashboard.monitors.find((monitor) => monitor.key === monitorKey)?.id ??
        "",
    );
    expect(noisyProposal).toMatchObject({
      currentThreshold: 3,
      proposedThreshold: 4,
      requiresApproval: true,
    });
    const applied = await store.applyTuning(
      "admin-proof",
      dashboard.monitors.find((monitor) => monitor.key === monitorKey)?.id ??
        "",
    );
    expect(applied).toMatchObject({ previousThreshold: 3, threshold: 4 });
    const monitorId =
      dashboard.monitors.find((monitor) => monitor.key === monitorKey)?.id ??
      "";
    const rejectedProposal = await store.proposeTuning(monitorId);
    expect(rejectedProposal).toMatchObject({
      currentThreshold: 4,
      proposedThreshold: 5,
      requiresApproval: true,
    });
    const auditedStore = createProductionEngineerStore(
      database,
      undefined,
      createAuditStore(database),
    );
    const rejected = await auditedStore.rejectTuning("admin-proof", monitorId);
    expect(rejected).toMatchObject({ threshold: 4, rejectedThreshold: 5 });
    const [unchangedMonitor] = await database
      .select()
      .from(productionMonitors)
      .where(eq(productionMonitors.id, monitorId));
    expect(unchangedMonitor).toMatchObject({
      threshold: 4,
      tuningProposal: {},
    });
    const [rejectionAudit] = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, monitorId));
    expect(rejectionAudit).toMatchObject({
      eventType: "production.tuning_rejected",
      actorUserId: "admin-proof",
    });

    const approvalGatedStore = createProductionEngineerStore(
      database,
      async (input) => ({
        branch: `openbot/production-${input.issueId.slice(0, 8)}`,
        pullRequestUrl: `https://example.test/pull/${input.issueId}`,
      }),
    );
    const drafted = await approvalGatedStore.draftFix(
      "admin-proof",
      triage.issue.id,
    );
    expect(drafted.branch).toStartWith("openbot/production-");
    const [persistedIssue] = await database
      .select()
      .from(productionIssues)
      .where(eq(productionIssues.id, triage.issue.id));
    expect(persistedIssue).toMatchObject({
      fixStatus: "pull_request_open",
      humanApprovedBy: "admin-proof",
      fixBranch: drafted.branch,
      pullRequestUrl: drafted.pullRequestUrl,
    });
    const resolved = await auditedStore.setIssueStatus(
      "admin-proof",
      triage.issue.id,
      "resolved",
    );
    expect(resolved.status).toBe("resolved");
    const reopened = await auditedStore.setIssueStatus(
      "admin-proof",
      triage.issue.id,
      "open",
    );
    expect(reopened.status).toBe("open");
  });
});
