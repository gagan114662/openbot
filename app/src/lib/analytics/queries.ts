import { client } from "@/lib/client";

export type AnalyticsOverview = {
  totals: {
    sessions: number;
    users: number;
    agents: number;
    evaluated: number;
    successful: number;
    failed: number;
    avgLatencyMs: number;
    avgActiveLatencyMs: number;
    totalHumanWaitMs: number;
    totalToolCalls: number;
    avgToolCalls: number;
    totalTokens: number;
    costMicros: number;
  };
  models: Array<{
    model: string | null;
    sessions: number;
    avgLatencyMs: number;
    avgActiveLatencyMs: number;
    failureRate: number;
    costMicros: number;
  }>;
  weeklyRoi: {
    humanMinutesSaved: number;
    laborValueMicros: number;
    revenueMicros: number;
    generatedValueMicros: number;
    netValueMicros: number;
  };
};

export type AnalyticsSession = {
  id: string;
  source: string;
  agentId: string | null;
  userId: string | null;
  status: string;
  intent: string | null;
  summary: string | null;
  model: string | null;
  privacyMode: string;
  taskCompleted: boolean | null;
  technicalFailure: boolean;
  toolFailure: boolean;
  toolVerified: boolean | null;
  escalation: "reached" | "failed" | null;
  humanIntervention: boolean;
  totalTokens: number;
  costMicros: number;
  latencyMs: number | null;
  activeLatencyMs: number | null;
  humanWaitMs: number;
  toolCalls: number;
  startedAt: string;
};

export function analyticsSessionLabel(session: AnalyticsSession): string {
  if (session.intent) return session.intent;
  if (session.summary) return session.summary;
  if (session.source === "openbot-channel") return "Channel turn";
  return session.id;
}

export async function fetchAnalyticsOverview(): Promise<AnalyticsOverview> {
  const response = await client("/api/analytics/admin/overview");
  return response.json() as Promise<AnalyticsOverview>;
}

export async function fetchAnalyticsSessions(
  search = "",
  page = 0,
  pageSize = 25,
  filters: {
    status?: string;
    taskCompleted?: boolean;
    technicalFailure?: boolean;
  } = {},
) {
  const parameters = new URLSearchParams({
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  if (search) parameters.set("search", search);
  if (filters.status) parameters.set("status", filters.status);
  if (filters.taskCompleted !== undefined)
    parameters.set("taskCompleted", String(filters.taskCompleted));
  if (filters.technicalFailure !== undefined)
    parameters.set("technicalFailure", String(filters.technicalFailure));
  const response = await client(
    `/api/analytics/admin/sessions?${parameters.toString()}`,
  );
  return response.json() as Promise<{ sessions: AnalyticsSession[] }>;
}

export type AnalyticsSessionDetail = {
  session: AnalyticsSession & { properties?: Record<string, unknown> };
  events: Array<{
    id: string;
    eventType: string;
    name: string;
    success: boolean | null;
    occurredAt: string;
    properties: Record<string, unknown>;
  }>;
  spans: Array<{
    id: string;
    kind: string;
    name: string;
    status: string;
    startedAt: string;
  }>;
  feedback: Array<{
    id: string;
    rating: number | null;
    category: string | null;
  }>;
  reviews: Array<{
    id: string;
    label: string;
    note: string | null;
    errorCategory: string | null;
  }>;
  topics: Array<{
    id: string;
    name: string;
    source: string;
  }>;
};

export async function fetchAnalyticsSessionDetail(sessionId: string) {
  const response = await client(
    `/api/analytics/admin/sessions/${encodeURIComponent(sessionId)}`,
  );
  return response.json() as Promise<AnalyticsSessionDetail>;
}

export type AnalyticsGovernance = {
  verifiedEpisodes: number;
  debtReviews: number;
  evaluators: Array<{
    id: string;
    name: string;
    kind: string;
    lifecycle: string;
  }>;
  datasets: Array<{ id: string; name: string; golden: boolean }>;
  runs: Array<{ id: string; status: string; regression: boolean }>;
  reviews: Array<{ id: string; status: string; label: string | null }>;
  topics: Array<{ id: string; name: string }>;
  toolUsage: Array<{
    agentId: string | null;
    tool: string;
    calls: number;
    costMicros: number;
  }>;
  outcomes: Array<{
    name: string;
    agentId: string | null;
    conversions: number;
    revenueMicros: number;
    taskSuccessRate: number;
  }>;
  topicScorecards: Array<{
    topicId: string;
    name: string;
    sessions: number;
    successRate: number;
  }>;
  journeys: Array<{
    threadId: string;
    agentId: string | null;
    turns: number;
    firstOutcome: boolean | null;
    lastOutcome: boolean | null;
    improved: boolean;
    conversions: number;
    revenueMicros: number;
    startedAt: string;
    endedAt: string;
  }>;
};

export async function fetchAnalyticsGovernance(): Promise<AnalyticsGovernance> {
  const response = await client("/api/analytics/admin/governance");
  return response.json() as Promise<AnalyticsGovernance>;
}

export async function bootstrapAnalyticsEvaluators() {
  const response = await client("/api/analytics/admin/evaluators/bootstrap", {
    method: "POST",
  });
  return response.json() as Promise<AnalyticsGovernance>;
}

export async function runAnalyticsEvaluator(input: {
  evaluatorId: string;
  datasetId?: string;
}) {
  const response = await client(
    `/api/analytics/admin/evaluators/${encodeURIComponent(input.evaluatorId)}/run`,
    { method: "POST", body: { datasetId: input.datasetId } },
  );
  return response.json() as Promise<{ runId: string; sessions: number }>;
}

export async function createAnalyticsDataset(input: {
  name: string;
  golden: boolean;
  sessionIds: string[];
}) {
  const response = await client("/api/analytics/admin/datasets", {
    method: "POST",
    body: input,
  });
  return response.json();
}

export async function createAnalyticsLlmJudge() {
  const response = await client("/api/analytics/admin/evaluators", {
    method: "POST",
    body: {
      name: "Calibrated Quality Judge",
      description: "Scores task quality from privacy-safe session evidence.",
      kind: "llm_judge",
      scoreType: "numeric",
      definition: {
        rubric:
          "Score whether the response completed the user's task accurately, safely, and without avoidable friction.",
        threshold: 70,
      },
    },
  });
  return response.json();
}

export async function reviewAnalyticsSession(input: {
  sessionId: string;
  label: string;
  note?: string;
  errorCategory?: string;
}) {
  const response = await client(
    `/api/analytics/admin/sessions/${encodeURIComponent(input.sessionId)}/review`,
    {
      method: "POST",
      body: {
        status: "completed",
        label: input.label,
        note: input.note,
        errorCategory: input.errorCategory,
      },
    },
  );
  return response.json();
}

export function revenueMicrosFromDollars(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  const micros = whole * 1_000_000 + fraction;
  return Number.isSafeInteger(micros) ? micros : null;
}

export async function recordAnalyticsBusinessOutcome(input: {
  sessionId: string;
  name: string;
  revenueMicros: number;
  humanMinutesSaved: number;
  laborValueMicros: number;
}) {
  const response = await client(
    `/api/analytics/admin/sessions/${encodeURIComponent(input.sessionId)}/outcomes`,
    {
      method: "POST",
      body: {
        name: input.name,
        success: true,
        revenueMicros: input.revenueMicros,
        humanMinutesSaved: input.humanMinutesSaved,
        laborValueMicros: input.laborValueMicros,
      },
    },
  );
  return response.json();
}

export async function classifyAnalyticsSession(input: {
  sessionId: string;
  name: string;
}) {
  const response = await client(
    `/api/analytics/admin/sessions/${encodeURIComponent(input.sessionId)}/topics`,
    {
      method: "POST",
      body: { name: input.name, confidence: 100 },
    },
  );
  return response.json();
}

export async function clusterAnalyticsTopics() {
  const response = await client("/api/analytics/admin/topics/cluster", {
    method: "POST",
  });
  return response.json() as Promise<{ assigned: number }>;
}
