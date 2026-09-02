import { client } from "@/lib/client";

export type ProductionTuningProposal = {
  currentThreshold: number;
  proposedThreshold: number;
  reason: string;
  requiresApproval: boolean;
};

export function tuningProposalFrom(
  value: Record<string, unknown>,
): ProductionTuningProposal | null {
  if (
    typeof value.currentThreshold !== "number" ||
    typeof value.proposedThreshold !== "number" ||
    typeof value.reason !== "string" ||
    typeof value.requiresApproval !== "boolean"
  ) {
    return null;
  }
  return {
    currentThreshold: value.currentThreshold,
    proposedThreshold: value.proposedThreshold,
    reason: value.reason,
    requiresApproval: value.requiresApproval,
  };
}

export function fixAutomationMessage(enabled: boolean): string {
  return enabled
    ? "Fix automation is enabled. Every draft still requires an administrator click and opens a reviewable branch; it never merges directly."
    : "Fix automation is off for this deployment. Set PRODUCTION_ENGINEER_FIX_AUTOMATION=true and restart the server to allow administrator-approved draft pull requests.";
}

export type ProductionEngineerDashboard = {
  fixAutomationEnabled: boolean;
  monitors: Array<{
    id: string;
    key: string;
    title: string;
    threshold: number;
    baseline: number | null;
    firingCount: number;
    falsePositiveCount: number;
    tuningProposal: Record<string, unknown>;
  }>;
  issues: Array<{
    id: string;
    title: string;
    status: string;
    severity: string;
    rootCause: string;
    fixStatus: string;
    pullRequestUrl: string | null;
    updatedAt: string;
  }>;
  investigations: Array<{
    id: string;
    issueId: string;
    summary: string;
    outcome: string;
    approved: boolean;
  }>;
};

export async function fetchProductionEngineer() {
  const response = await client("/api/production-engineer");
  return response.json() as Promise<ProductionEngineerDashboard>;
}

export async function tuneProductionMonitor(monitorId: string) {
  const response = await client(
    `/api/production-engineer/monitors/${encodeURIComponent(monitorId)}/tune`,
    { method: "POST" },
  );
  return response.json();
}

export async function applyProductionMonitorTuning(monitorId: string) {
  const response = await client(
    `/api/production-engineer/monitors/${encodeURIComponent(monitorId)}/tune/apply`,
    { method: "POST" },
  );
  return response.json();
}

export async function rejectProductionMonitorTuning(monitorId: string) {
  const response = await client(
    `/api/production-engineer/monitors/${encodeURIComponent(monitorId)}/tune/reject`,
    { method: "POST" },
  );
  return response.json();
}

export async function draftProductionFix(issueId: string) {
  const response = await client(
    `/api/production-engineer/issues/${encodeURIComponent(issueId)}/fix`,
    { method: "POST" },
  );
  return response.json();
}

export async function updateProductionIssueStatus(input: {
  issueId: string;
  status: "open" | "resolved" | "dismissed";
}) {
  const response = await client(
    `/api/production-engineer/issues/${encodeURIComponent(input.issueId)}/status`,
    { method: "PATCH", body: { status: input.status } },
  );
  return response.json();
}

export async function recordProductionInvestigation(input: {
  issueId: string;
  summary: string;
  outcome: string;
  approved: boolean;
}) {
  const response = await client(
    `/api/production-engineer/issues/${encodeURIComponent(input.issueId)}/investigations`,
    {
      method: "POST",
      body: {
        summary: input.summary,
        outcome: input.outcome,
        approved: input.approved,
      },
    },
  );
  return response.json();
}
