import { IconDownload, IconRefresh } from "@tabler/icons-react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ratioPercent } from "@/lib/analytics/metrics";
import {
  analyticsSessionLabel,
  bootstrapAnalyticsEvaluators,
  classifyAnalyticsSession,
  clusterAnalyticsTopics,
  createAnalyticsDataset,
  createAnalyticsLlmJudge,
  fetchAnalyticsGovernance,
  fetchAnalyticsOverview,
  fetchAnalyticsSessionDetail,
  fetchAnalyticsSessions,
  recordAnalyticsBusinessOutcome,
  revenueMicrosFromDollars,
  reviewAnalyticsSession,
  runAnalyticsEvaluator,
} from "@/lib/analytics/queries";

export const Route = createFileRoute("/_authed/admin/analytics")({
  component: AgentAnalyticsPage,
});

const SESSION_PAGE_SIZE = 25;

export function AgentAnalyticsPage() {
  const [search, setSearch] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [page, setPage] = useState(0);
  const [datasetName, setDatasetName] = useState("");
  const [evaluationDatasetId, setEvaluationDatasetId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [reviewLabel, setReviewLabel] = useState("reviewed");
  const [reviewNote, setReviewNote] = useState("");
  const [topicName, setTopicName] = useState("");
  const [outcomeName, setOutcomeName] = useState("");
  const [outcomeRevenue, setOutcomeRevenue] = useState("");
  const [outcomeSessionId, setOutcomeSessionId] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(
    () => new Set(),
  );
  const queryClient = useQueryClient();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledSearch(search.trim());
      setPage(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const overview = useQuery({
    queryKey: ["agent-analytics", "overview"],
    queryFn: fetchAnalyticsOverview,
  });
  const sessions = useQuery({
    queryKey: [
      "agent-analytics",
      "sessions",
      settledSearch,
      page,
      statusFilter,
      outcomeFilter,
    ],
    queryFn: () =>
      fetchAnalyticsSessions(settledSearch, page, SESSION_PAGE_SIZE, {
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(outcomeFilter === "success" ? { taskCompleted: true } : {}),
        ...(outcomeFilter === "failure" ? { taskCompleted: false } : {}),
        ...(outcomeFilter === "technical" ? { technicalFailure: true } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const sessionDetail = useQuery({
    queryKey: ["agent-analytics", "session-detail", selectedSessionId],
    queryFn: () => fetchAnalyticsSessionDetail(selectedSessionId),
    enabled: Boolean(selectedSessionId),
  });
  useEffect(() => {
    const review = sessionDetail.data?.reviews[0];
    const humanTopic = sessionDetail.data?.topics.find(
      (topic) => topic.source === "human",
    );
    setReviewLabel(review?.label ?? "reviewed");
    setReviewNote(review?.note ?? "");
    setTopicName(humanTopic?.name ?? "");
  }, [sessionDetail.data]);
  const governance = useQuery({
    queryKey: ["agent-analytics", "governance"],
    queryFn: fetchAnalyticsGovernance,
  });
  const totals = overview.data?.totals;
  const bootstrap = useMutation({
    mutationFn: bootstrapAnalyticsEvaluators,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agent-analytics", "governance"],
      }),
  });
  const runEvaluator = useMutation({
    mutationFn: runAnalyticsEvaluator,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agent-analytics", "governance"],
      }),
  });
  const createDataset = useMutation({
    mutationFn: createAnalyticsDataset,
    onSuccess: () => {
      setDatasetName("");
      setSelectedSessions(new Set());
      return queryClient.invalidateQueries({
        queryKey: ["agent-analytics", "governance"],
      });
    },
  });
  const createLlmJudge = useMutation({
    mutationFn: createAnalyticsLlmJudge,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agent-analytics", "governance"],
      }),
  });
  const reviewSession = useMutation({
    mutationFn: reviewAnalyticsSession,
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-analytics", "governance"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-analytics", "session-detail", selectedSessionId],
        }),
      ]);
    },
  });
  const classifySession = useMutation({
    mutationFn: classifyAnalyticsSession,
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-analytics", "governance"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-analytics", "session-detail", selectedSessionId],
        }),
      ]);
    },
  });
  const clusterTopics = useMutation({
    mutationFn: clusterAnalyticsTopics,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agent-analytics", "governance"],
      }),
  });
  const recordOutcome = useMutation({
    mutationFn: recordAnalyticsBusinessOutcome,
    onSuccess: () => {
      setOutcomeName("");
      setOutcomeRevenue("");
      return queryClient.invalidateQueries({
        queryKey: ["agent-analytics", "governance"],
      });
    },
  });
  const refreshing =
    overview.isFetching || sessions.isFetching || governance.isFetching;

  return (
    <PageShell
      action={
        <div className="flex gap-2">
          <Button
            onClick={() =>
              void Promise.all([
                overview.refetch(),
                sessions.refetch(),
                governance.refetch(),
              ])
            }
            disabled={refreshing}
            size="sm"
            variant="ghost"
          >
            <IconRefresh /> {refreshing ? "Refreshing…" : "Refresh"}
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
            <Metric
              label="Sessions"
              loading={overview.isPending}
              value={totals?.sessions ?? 0}
            />
            <Metric
              label="Task success"
              loading={overview.isPending}
              value={ratioPercent(totals?.successful, totals?.evaluated)}
            />
            <Metric
              label="Evaluation coverage"
              loading={overview.isPending}
              value={ratioPercent(totals?.evaluated, totals?.sessions)}
            />
            <Metric
              label="Failure rate"
              loading={overview.isPending}
              value={ratioPercent(totals?.failed, totals?.sessions)}
            />
            <Metric
              label="Average active time"
              loading={overview.isPending}
              value={`${totals?.avgActiveLatencyMs ?? 0} ms`}
            />
            <Metric
              label="Average wall time"
              loading={overview.isPending}
              value={`${totals?.avgLatencyMs ?? 0} ms`}
            />
            <Metric
              label="Human wait total"
              loading={overview.isPending}
              value={`${totals?.totalHumanWaitMs ?? 0} ms`}
            />
            <Metric
              label="Average tool calls"
              loading={overview.isPending}
              value={(totals?.avgToolCalls ?? 0).toFixed(1)}
            />
            <Metric
              label="Users"
              loading={overview.isPending}
              value={totals?.users ?? 0}
            />
            <Metric
              label="Agents"
              loading={overview.isPending}
              value={totals?.agents ?? 0}
            />
            <Metric
              label="Tokens"
              loading={overview.isPending}
              value={(totals?.totalTokens ?? 0).toLocaleString()}
            />
            <Metric
              label="Allocated cost"
              loading={overview.isPending}
              value={`$${((totals?.costMicros ?? 0) / 1_000_000).toFixed(2)}`}
            />
          </div>
        )}
      </PageSection>

      <PageSection title="Model comparison">
        {overview.isPending ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading model comparison…
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Sessions</th>
                  <th className="px-4 py-2">Active latency</th>
                  <th className="px-4 py-2">Failure</th>
                  <th className="px-4 py-2">Allocated cost</th>
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
        )}
      </PageSection>

      <PageSection title="Evaluation operations">
        {governance.isError ? (
          <p className="text-destructive text-sm">
            Evaluation operations could not be loaded.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Evaluators"
              loading={governance.isPending}
              value={governance.data?.evaluators.length ?? 0}
            />
            <Metric
              label="Datasets"
              loading={governance.isPending}
              value={governance.data?.datasets.length ?? 0}
            />
            <Metric
              label="Eval runs"
              loading={governance.isPending}
              value={governance.data?.runs.length ?? 0}
            />
            <Metric
              label="Review queue"
              loading={governance.isPending}
              value={
                governance.data?.reviews.filter(
                  (review) => review.status === "pending",
                ).length ?? 0
              }
            />
            <Metric
              label="Topics"
              loading={governance.isPending}
              value={governance.data?.topics.length ?? 0}
            />
            <Metric
              label="Verified episodes"
              loading={governance.isPending}
              value={governance.data?.verifiedEpisodes ?? 0}
            />
            <Metric
              label="Debt reviews"
              loading={governance.isPending}
              value={governance.data?.debtReviews ?? 0}
            />
          </div>
        )}
        {governance.isPending ? (
          <p className="mt-3 text-muted-foreground text-sm" role="status">
            Loading evaluation operations…
          </p>
        ) : (
          <p className="mt-3 text-muted-foreground text-sm">
            Regressions:{" "}
            {governance.data?.runs.filter((run) => run.regression).length ?? 0}.
            Active evaluators:{" "}
            {governance.data?.evaluators.filter(
              (evaluator) => evaluator.lifecycle === "active",
            ).length ?? 0}
            . Golden datasets:{" "}
            {governance.data?.datasets.filter((dataset) => dataset.golden)
              .length ?? 0}
            .
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <select
            aria-label="Evaluation dataset"
            className="rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => setEvaluationDatasetId(event.target.value)}
            value={evaluationDatasetId}
          >
            <option value="">Latest 500 sessions</option>
            {(governance.data?.datasets ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name}
              </option>
            ))}
          </select>
          <Button
            disabled={bootstrap.isPending}
            onClick={() => bootstrap.mutate()}
            size="sm"
            variant="outline"
          >
            Install built-in signals
          </Button>
          <Button
            disabled={createLlmJudge.isPending}
            onClick={() => createLlmJudge.mutate()}
            size="sm"
            variant="outline"
          >
            Create LLM judge
          </Button>
          <Button
            disabled={clusterTopics.isPending}
            onClick={() => clusterTopics.mutate()}
            size="sm"
            variant="outline"
          >
            Cluster topics
          </Button>
          {(governance.data?.evaluators ?? []).map((evaluator) => (
            <Button
              disabled={runEvaluator.isPending}
              key={evaluator.id}
              onClick={() =>
                runEvaluator.mutate({
                  evaluatorId: evaluator.id,
                  ...(evaluationDatasetId
                    ? { datasetId: evaluationDatasetId }
                    : {}),
                })
              }
              size="sm"
              variant="ghost"
            >
              Run {evaluator.name}
            </Button>
          ))}
        </div>
        <div className="mt-4 flex max-w-lg gap-2">
          <Input
            aria-label="Dataset name"
            onChange={(event) => setDatasetName(event.target.value)}
            placeholder="New golden dataset"
            value={datasetName}
          />
          <Button
            disabled={!datasetName.trim() || createDataset.isPending}
            onClick={() =>
              createDataset.mutate({
                name: datasetName.trim(),
                golden: true,
                sessionIds: [...selectedSessions],
              })
            }
            size="sm"
          >
            Create dataset ({selectedSessions.size} sessions)
          </Button>
        </div>
      </PageSection>

      <PageSection title="Topic scorecards">
        <AnalyticsTable
          empty="Run topic clustering to build the first scorecards."
          headers={["Topic", "Sessions", "Task success"]}
          loading={governance.isPending}
          rows={(governance.data?.topicScorecards ?? []).map((item) => [
            item.name,
            item.sessions.toLocaleString(),
            `${(item.successRate * 100).toFixed(1)}%`,
          ])}
        />
      </PageSection>

      <PageSection title="Multi-turn journeys">
        <AnalyticsTable
          empty="No thread has two measured turns yet."
          headers={[
            "Thread",
            "Bot",
            "Turns",
            "First → latest",
            "Conversions",
            "Revenue",
          ]}
          loading={governance.isPending}
          rows={(governance.data?.journeys ?? []).map((journey) => [
            journey.threadId,
            journey.agentId ?? "Unknown",
            journey.turns.toLocaleString(),
            `${journey.firstOutcome === null ? "unevaluated" : journey.firstOutcome ? "success" : "failed"} → ${journey.lastOutcome === null ? "unevaluated" : journey.lastOutcome ? "success" : "failed"}${journey.improved ? " (improved)" : ""}`,
            journey.conversions.toLocaleString(),
            `$${(journey.revenueMicros / 1_000_000).toFixed(2)}`,
          ])}
        />
      </PageSection>

      <PageSection title="Tool and business outcomes">
        <div className="mb-4 grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_10rem_auto]">
          <label className="grid gap-1 text-sm">
            Session
            <select
              aria-label="Outcome session"
              className="h-9 rounded-md border border-input bg-background px-3"
              onChange={(event) => setOutcomeSessionId(event.target.value)}
              value={outcomeSessionId || sessions.data?.sessions[0]?.id || ""}
            >
              {(sessions.data?.sessions ?? []).map((session) => (
                <option key={session.id} value={session.id}>
                  {analyticsSessionLabel(session)} ·{" "}
                  {session.agentId ?? "Unknown Bot"}
                </option>
              ))}
            </select>
          </label>
          <Input
            aria-label="Outcome name"
            onChange={(event) => setOutcomeName(event.target.value)}
            placeholder="Qualified workflow conversion"
            value={outcomeName}
          />
          <Input
            aria-label="Revenue dollars"
            inputMode="decimal"
            onChange={(event) => setOutcomeRevenue(event.target.value)}
            placeholder="Revenue ($)"
            value={outcomeRevenue}
          />
          <Button
            className="self-end"
            disabled={
              !outcomeName.trim() ||
              !(outcomeSessionId || sessions.data?.sessions[0]?.id) ||
              revenueMicrosFromDollars(outcomeRevenue) === null ||
              recordOutcome.isPending
            }
            onClick={() => {
              const revenueMicros = revenueMicrosFromDollars(outcomeRevenue);
              const sessionId =
                outcomeSessionId || sessions.data?.sessions[0]?.id || "";
              if (revenueMicros === null || !sessionId) return;
              recordOutcome.mutate({
                sessionId,
                name: outcomeName.trim(),
                revenueMicros,
              });
            }}
            size="sm"
          >
            Record outcome
          </Button>
          {recordOutcome.isError ? (
            <p className="text-destructive text-sm md:col-span-4" role="alert">
              {recordOutcome.error.message}
            </p>
          ) : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <AnalyticsTable
            empty="No tool calls have been metered yet."
            headers={["Bot", "Tool", "Calls", "Allocated cost"]}
            loading={governance.isPending}
            rows={(governance.data?.toolUsage ?? []).map((item) => [
              item.agentId ?? "Unknown",
              item.tool,
              item.calls.toLocaleString(),
              `$${(item.costMicros / 1_000_000).toFixed(4)}`,
            ])}
          />
          <AnalyticsTable
            empty="No conversion or revenue outcomes have been recorded yet."
            headers={[
              "Outcome",
              "Bot",
              "Conversions",
              "Task success",
              "Revenue",
            ]}
            loading={governance.isPending}
            rows={(governance.data?.outcomes ?? []).map((item) => [
              item.name,
              item.agentId ?? "Unknown",
              item.conversions.toLocaleString(),
              `${(item.taskSuccessRate * 100).toFixed(1)}%`,
              `$${(item.revenueMicros / 1_000_000).toFixed(2)}`,
            ])}
          />
        </div>
      </PageSection>

      <PageSection title="Session explorer">
        <div className="mb-4 flex flex-wrap gap-2">
          <Input
            aria-label="Search sessions"
            className="max-w-md"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search intent, summary, or session id"
            value={search}
          />
          <select
            aria-label="Session status"
            className="rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(0);
            }}
            value={statusFilter}
          >
            <option value="">Every status</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="abandoned">Abandoned</option>
            <option value="running">Running</option>
          </select>
          <select
            aria-label="Session outcome"
            className="rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => {
              setOutcomeFilter(event.target.value);
              setPage(0);
            }}
            value={outcomeFilter}
          >
            <option value="">Every outcome</option>
            <option value="success">Task succeeded</option>
            <option value="failure">Task failed</option>
            <option value="technical">Technical failure</option>
          </select>
        </div>
        {selectedSessionId ? (
          <div className="mb-4 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Trace detail</h3>
              <Button
                onClick={() => setSelectedSessionId("")}
                size="sm"
                variant="ghost"
              >
                Close
              </Button>
            </div>
            {sessionDetail.isPending ? (
              <p role="status">Loading trace…</p>
            ) : sessionDetail.isError ? (
              <p className="text-destructive" role="alert">
                Trace could not be loaded.
              </p>
            ) : (
              <>
                <p className="mt-2 font-mono text-muted-foreground text-xs">
                  {selectedSessionId}
                </p>
                <ol className="mt-3 space-y-1 text-sm">
                  {(sessionDetail.data?.events ?? []).map((event) => (
                    <li key={event.id}>
                      {new Date(event.occurredAt).toLocaleTimeString()} ·{" "}
                      {event.eventType} · {event.name} ·{" "}
                      {event.success === false ? "failed" : "observed"}
                    </li>
                  ))}
                  {(sessionDetail.data?.spans ?? []).map((span) => (
                    <li key={span.id}>
                      span · {span.kind} · {span.name} · {span.status}
                    </li>
                  ))}
                </ol>
                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  <Input
                    aria-label="Review label"
                    onChange={(event) => setReviewLabel(event.target.value)}
                    placeholder="Review label"
                    value={reviewLabel}
                  />
                  <Input
                    aria-label="Review note"
                    onChange={(event) => setReviewNote(event.target.value)}
                    placeholder="Review note"
                    value={reviewNote}
                  />
                  <Button
                    disabled={!reviewLabel.trim() || reviewSession.isPending}
                    onClick={() =>
                      reviewSession.mutate({
                        sessionId: selectedSessionId,
                        label: reviewLabel.trim(),
                        note: reviewNote.trim() || undefined,
                      })
                    }
                  >
                    Save review
                  </Button>
                  <Input
                    aria-label="Topic name"
                    onChange={(event) => setTopicName(event.target.value)}
                    placeholder="Topic name"
                    value={topicName}
                  />
                  <Button
                    disabled={!topicName.trim() || classifySession.isPending}
                    onClick={() =>
                      classifySession.mutate({
                        sessionId: selectedSessionId,
                        name: topicName.trim(),
                      })
                    }
                  >
                    Assign topic
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}
        {sessions.isPending ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading sessions…
          </p>
        ) : sessions.isError ? (
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
                  <th className="px-4 py-2">Dataset</th>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Intent</th>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Outcome</th>
                  <th className="px-4 py-2">Active / wall</th>
                  <th className="px-4 py-2">Tool calls</th>
                  <th className="px-4 py-2">Tool proof</th>
                  <th className="px-4 py-2">Human gate</th>
                  <th className="px-4 py-2">Privacy</th>
                  <th className="px-4 py-2">Allocated cost</th>
                  <th className="px-4 py-2">Review</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data?.sessions.map((session) => (
                  <tr
                    className="border-border border-t"
                    key={session.id}
                    title={session.id}
                  >
                    <td className="px-4 py-2">
                      <input
                        aria-label={`Select ${analyticsSessionLabel(session)} for dataset`}
                        checked={selectedSessions.has(session.id)}
                        onChange={(event) => {
                          setSelectedSessions((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(session.id);
                            else next.delete(session.id);
                            return next;
                          });
                        }}
                        type="checkbox"
                      />
                    </td>
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
                    <td className="whitespace-nowrap px-4 py-2">
                      <Button
                        disabled={reviewSession.isPending}
                        onClick={() => setSelectedSessionId(session.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-border border-t p-3">
              <Button
                disabled={page === 0 || sessions.isFetching}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                size="sm"
                variant="ghost"
              >
                Previous
              </Button>
              <span className="text-muted-foreground text-sm" role="status">
                Page {page + 1}
                {sessions.isFetching ? " · Updating…" : ""}
              </span>
              <Button
                disabled={
                  sessions.isFetching ||
                  (sessions.data?.sessions.length ?? 0) < SESSION_PAGE_SIZE
                }
                onClick={() => setPage((current) => current + 1)}
                size="sm"
                variant="ghost"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function AnalyticsTable({
  headers,
  rows,
  empty,
  loading = false,
}: {
  headers: string[];
  rows: string[][];
  empty: string;
  loading?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      {loading ? (
        <p className="p-4 text-muted-foreground text-sm" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-muted-foreground text-sm">{empty}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground text-xs uppercase">
            <tr>
              {headers.map((header) => (
                <th className="px-4 py-2" key={header}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-border border-t" key={row.join(":")}>
                {row.map((cell, cellIndex) => (
                  <td className="px-4 py-2" key={headers[cellIndex]}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  loading = false,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-muted-foreground text-xs uppercase">{label}</div>
      {loading ? (
        <div
          aria-label={`Loading ${label.toLowerCase()}`}
          className="mt-2"
          role="status"
        >
          <Skeleton className="h-7 w-20 motion-reduce:animate-none" />
        </div>
      ) : (
        <div className="mt-1 font-semibold text-2xl">{value}</div>
      )}
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
