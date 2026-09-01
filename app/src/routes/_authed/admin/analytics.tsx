import { IconDownload, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ratioPercent } from "@/lib/analytics/metrics";
import {
  analyticsSessionLabel,
  fetchAnalyticsOverview,
  fetchAnalyticsSessions,
} from "@/lib/analytics/queries";

export const Route = createFileRoute("/_authed/admin/analytics")({
  component: AgentAnalyticsPage,
});

function AgentAnalyticsPage() {
  const [search, setSearch] = useState("");
  const overview = useQuery({
    queryKey: ["agent-analytics", "overview"],
    queryFn: fetchAnalyticsOverview,
  });
  const sessions = useQuery({
    queryKey: ["agent-analytics", "sessions", search],
    queryFn: () => fetchAnalyticsSessions(search),
  });
  const totals = overview.data?.totals;

  return (
    <PageShell
      action={
        <div className="flex gap-2">
          <Button
            onClick={() =>
              void Promise.all([overview.refetch(), sessions.refetch()])
            }
            size="sm"
            variant="ghost"
          >
            <IconRefresh /> Refresh
          </Button>
          <Button
            render={<a href="/api/analytics/admin/export" />}
            size="sm"
            variant="outline"
          >
            <IconDownload /> Export JSONL
          </Button>
        </div>
      }
      description="Trace agent behavior, quality, cost, and product outcomes without crossing the selected privacy boundary."
      title="Agent Analytics"
      width="wide"
    >
      <PageSection>
        {overview.isError ? (
          <p className="text-destructive text-sm">
            Analytics could not be loaded.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sessions" value={totals?.sessions ?? 0} />
            <Metric
              label="Task success"
              value={ratioPercent(totals?.successful, totals?.evaluated)}
            />
            <Metric
              label="Evaluation coverage"
              value={ratioPercent(totals?.evaluated, totals?.sessions)}
            />
            <Metric
              label="Failure rate"
              value={ratioPercent(totals?.failed, totals?.sessions)}
            />
            <Metric
              label="Average active time"
              value={`${totals?.avgActiveLatencyMs ?? 0} ms`}
            />
            <Metric
              label="Average wall time"
              value={`${totals?.avgLatencyMs ?? 0} ms`}
            />
            <Metric
              label="Human wait total"
              value={`${totals?.totalHumanWaitMs ?? 0} ms`}
            />
            <Metric
              label="Average tool calls"
              value={(totals?.avgToolCalls ?? 0).toFixed(1)}
            />
            <Metric label="Users" value={totals?.users ?? 0} />
            <Metric label="Agents" value={totals?.agents ?? 0} />
            <Metric
              label="Tokens"
              value={(totals?.totalTokens ?? 0).toLocaleString()}
            />
            <Metric
              label="Spend"
              value={`$${((totals?.costMicros ?? 0) / 1_000_000).toFixed(2)}`}
            />
          </div>
        )}
      </PageSection>

      <PageSection title="Model comparison">
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2">Sessions</th>
                <th className="px-4 py-2">Active latency</th>
                <th className="px-4 py-2">Failure</th>
                <th className="px-4 py-2">Spend</th>
              </tr>
            </thead>
            <tbody>
              {(overview.data?.models ?? []).map((model) => (
                <tr
                  className="border-border border-t"
                  key={model.model ?? "unknown"}
                >
                  <td className="px-4 py-2 font-medium">
                    {model.model ?? "Unknown"}
                  </td>
                  <td className="px-4 py-2">{model.sessions}</td>
                  <td className="px-4 py-2">{model.avgActiveLatencyMs} ms</td>
                  <td className="px-4 py-2">
                    {(model.failureRate * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2">
                    ${(model.costMicros / 1_000_000).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageSection>

      <PageSection title="Session explorer">
        <Input
          aria-label="Search sessions"
          className="mb-4 max-w-md"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search intent, summary, or session id"
          value={search}
        />
        {sessions.isPending ? null : sessions.isError ? (
          <p className="text-destructive text-sm">
            Sessions could not be loaded.
          </p>
        ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
          <PageEmpty>No sessions match this view yet.</PageEmpty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Intent</th>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Outcome</th>
                  <th className="px-4 py-2">Active / wall</th>
                  <th className="px-4 py-2">Tool calls</th>
                  <th className="px-4 py-2">Tool proof</th>
                  <th className="px-4 py-2">Human gate</th>
                  <th className="px-4 py-2">Privacy</th>
                  <th className="px-4 py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data?.sessions.map((session) => (
                  <tr
                    className="border-border border-t"
                    key={session.id}
                    title={session.id}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                      {new Date(session.startedAt).toLocaleString()}
                    </td>
                    <td className="max-w-md px-4 py-2">
                      <div className="truncate font-medium">
                        {analyticsSessionLabel(session)}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {session.agentId ?? "Unknown agent"}
                      </div>
                    </td>
                    <td className="px-4 py-2">{session.model ?? "-"}</td>
                    <td className="px-4 py-2">{outcome(session)}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {session.activeLatencyMs === null
                        ? "-"
                        : `${session.activeLatencyMs} / ${session.latencyMs} ms`}
                    </td>
                    <td className="px-4 py-2">{session.toolCalls}</td>
                    <td className="px-4 py-2">
                      {session.toolVerified === true
                        ? session.toolFailure
                          ? "Verified failure"
                          : "Verified"
                        : session.toolVerified === false
                          ? "Unmatched"
                          : "-"}
                    </td>
                    <td className="px-4 py-2">
                      {session.escalation === "reached"
                        ? "Audited escalation"
                        : session.escalation === "failed"
                          ? "Delivery failed"
                          : session.humanIntervention &&
                              session.status === "running"
                            ? "Waiting on person"
                            : session.humanIntervention
                              ? "Requested"
                              : "-"}
                    </td>
                    <td className="px-4 py-2">
                      {session.privacyMode.replaceAll("_", " ")}
                    </td>
                    <td className="px-4 py-2">
                      ${(session.costMicros / 1_000_000).toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-muted-foreground text-xs uppercase">{label}</div>
      <div className="mt-1 font-semibold text-2xl">{value}</div>
    </div>
  );
}

function outcome(session: {
  technicalFailure: boolean;
  toolFailure: boolean;
  taskCompleted: boolean | null;
  status: string;
}) {
  if (session.technicalFailure) return "Technical failure";
  if (session.toolFailure) return "Tool failure";
  if (session.taskCompleted === true) return "Completed";
  if (session.taskCompleted === false) return "Not completed";
  return session.status;
}
