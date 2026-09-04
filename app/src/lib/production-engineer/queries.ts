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
  runtimeBudgets: {
    evaluatorConcurrency: number;
    evaluatorInflight: number;
    shadowConcurrency: number;
    shadowQueueCapacity: number;
    shadowInflight: number;
    shadowDropped: number;
  };
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
  worktrees: { active: number; diskBytes: number };
  provenance: null | {
    revision: string;
    branch: string;
    dirty: boolean;
    workerId?: string;
  };
  executionTiers: string[];
  managedJobKinds: string[];
  contextGraph: { nodes: number; edges: number; sourceSystems: number };
  benchmarks: Array<{
    harness: "codex" | "claude";
    model: string;
    task: string;
    quality: number;
    successfulOutcomes: number;
    attemptedOutcomes: number;
    totalCostMicros: number;
    enabled: boolean;
    source: "measured" | "seeded";
    benchmarkRunId: string | null;
    seedReason: string | null;
  }>;
  jobs: Array<{
    id: string;
    kind: string;
    tier: string;
    objective: string;
    status: string;
    selectedModel: string | null;
    selectedHarness: string | null;
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
    failed: number;
    averageAgreement: number;
    averageLatencyMs: number;
    recent: Array<{
      id: string;
      requestKey: string;
      primaryModel: string;
      shadowModel: string;
      agreementBasisPoints: number;
      shadowLatencyMs: number;
      primaryOutputHash: string;
      shadowOutputHash: string;
      evaluatorVersion: string;
      status: string;
      error: string | null;
      createdAt: string;
    }>;
  };
  workflows: Array<{
    evidence: {
      terminal: boolean;
      readyForApproval: boolean;
      verified: boolean;
      checks: Record<string, boolean>;
    };
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
      dependsOn: { ids: string[] };
      objective: string;
      status: string;
      attempts: number;
      sessionId: string | null;
      reviewerSessionId: string | null;
      selectedModel: string | null;
      selectedHarness: string | null;
      verification: null | {
        accepted?: boolean;
        summary?: string;
        checks?: string[];
      };
      checks: {
        items?: unknown[];
        gate?: {
          kind: "human";
          prompt: string;
          roles?: string[];
          status: "pending" | "approved";
          feedback?: string;
        };
      };
      lastError: string | null;
    }>;
    artifacts: Array<{
      id: string;
      stageId: string;
      kind: string;
      uri: string;
      checksum: string;
      revision: string;
      producerSessionId: string;
      command: string;
      exitCode: number;
      metadata: null | {
        checks?: string[];
        diffBytes?: number;
        checkId?: string;
        durationMs?: number;
        required?: boolean;
        evidenceSource?: string;
        harness?: string;
        model?: string;
        trustedContext?: Array<{
          key: string;
          sourceSystem: string;
          sourceUrl: string | null;
          refreshedAt: string;
          checksum: string;
        }>;
        debt?: {
          metrics: Record<string, number>;
          budget: Record<string, number>;
          changedPaths: string[];
          violations: string[];
        };
      };
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

export function workflowEventDetail(detail: Record<string, unknown>) {
  if (detail.reason !== "stale-session") return null;
  const operation =
    typeof detail.operation === "string" ? detail.operation : "write";
  const expected =
    typeof detail.expected === "string" ? detail.expected : "none";
  const actual = typeof detail.actual === "string" ? detail.actual : "none";
  return `refused stale ${operation} · owner ${expected} · caller ${actual}`;
}

export async function fetchSoftwareFactory() {
  const response = await client("/api/software-factory");
  return response.json() as Promise<SoftwareFactoryDashboard>;
}

export async function createManagedJob(input: {
  kind: "pull-request-review" | "ci-repair" | "bug-triage" | "visual-delivery";
  objective: string;
  maximumAttempts: number;
  concurrencyLimit: number;
  requiredContext: string[];
  observableChange: { path: string; expectedContent: string };
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

export async function runFactoryBenchmark(id = "ci-repair-v1") {
  const response = await client(
    `/api/software-factory/benchmarks/${encodeURIComponent(id)}/run`,
    { method: "POST", body: {} },
  );
  if (!response.ok) throw new Error(await response.text());
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

export async function decideWorkflowGate(input: {
  runId: string;
  stageId: string;
  decision: "approve" | "reject";
  feedback?: string;
  producerStageId?: string;
}) {
  const response = await client(
    `/api/software-factory/workflows/${encodeURIComponent(input.runId)}/stages/${encodeURIComponent(input.stageId)}/decision`,
    { method: "POST", body: input },
  );
  if (!response.ok) throw new Error(await response.text());
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
