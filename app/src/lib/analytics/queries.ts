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

export async function fetchAnalyticsSessions(search = "") {
  const response = await client(
    `/api/analytics/admin/sessions${search ? `?search=${encodeURIComponent(search)}` : ""}`,
  );
  return response.json() as Promise<{ sessions: AnalyticsSession[] }>;
}
