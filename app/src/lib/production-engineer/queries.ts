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
  factory: {
    executionTiers: Array<"chat" | "assisted" | "managed" | "autonomous">;
    managedJobKinds: Array<
      "pull-request-review" | "ci-repair" | "bug-triage" | "visual-delivery"
    >;
    modelRouting: string;
    workerPattern: string;
    contextGraph: { nodes: number; edges: number; sourceSystems: number };
  };
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

export type SoftwareFactoryDashboard = {
  provenance: null | {
    revision: string;
    branch: string;
    dirty: boolean;
  };
  executionTiers: string[];
  managedJobKinds: string[];
  contextGraph: { nodes: number; edges: number; sourceSystems: number };
  benchmarks: Array<{
    model: string;
    task: string;
    quality: number;
    successfulOutcomes: number;
    attemptedOutcomes: number;
    totalCostMicros: number;
    enabled: boolean;
  }>;
  jobs: Array<{
    id: string;
    kind: string;
    tier: string;
    objective: string;
    status: string;
    selectedModel: string | null;
    costMicros: number;
  }>;
  webhooks: null | {
    pending: number;
    processed: number;
    dead: number;
    events: Array<{
      id: string;
      provider: string;
      eventId: string;
      status: string;
      attempts: number;
      lastError: string | null;
    }>;
  };
  shadowTraffic: null | {
    completed: number;
    averageAgreement: number;
    averageLatencyMs: number;
    recent: Array<{
      id: string;
      requestKey: string;
      primaryModel: string;
      shadowModel: string;
      agreementBasisPoints: number;
      shadowLatencyMs: number;
      createdAt: string;
    }>;
  };
  workflows: Array<{
    run: {
      id: string;
      jobId: string;
      status: string;
      maximumAttempts: number;
      concurrencyLimit: number;
      pauseRequested: boolean;
      abortRequested: boolean;
      approvedBy: string | null;
      steering: {
        events?: Array<{ actorId: string; instruction: string; at: string }>;
      };
    };
    stages: Array<{
      stageId: string;
      objective: string;
      status: string;
      attempts: number;
      sessionId: string | null;
      lastError: string | null;
    }>;
    events: Array<{
      id: string;
      stageId: string | null;
      entity: string;
      fromStatus: string | null;
      toStatus: string;
      detail: Record<string, unknown>;
      createdAt: string;
    }>;
  }>;
  contextCapsules: Array<{
    id: string;
    runId: string;
    threadId: string;
    checksum: string;
    createdAt: string;
  }>;
};

export async function fetchSoftwareFactory() {
  const response = await client("/api/software-factory");
  return response.json() as Promise<SoftwareFactoryDashboard>;
}

export async function createManagedJob(input: {
  kind: "pull-request-review" | "ci-repair" | "bug-triage" | "visual-delivery";
  objective: string;
  maximumAttempts: number;
  concurrencyLimit: number;
}) {
  const response = await client("/api/software-factory/jobs", {
    method: "POST",
    body: {
      ...input,
      tier: "managed",
      trigger: "operator-ui",
      minimumQuality: 0.8,
    },
  });
  return response.json();
}

export async function controlWorkflow(input: {
  runId: string;
  action: "pause" | "resume" | "abort" | "approve" | "steer";
  instruction?: string;
}) {
  const response = await client(
    `/api/software-factory/workflows/${encodeURIComponent(input.runId)}/${input.action}`,
    {
      method: "POST",
      body: input.instruction ? { instruction: input.instruction } : {},
    },
  );
  return response.json();
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
