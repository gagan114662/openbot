import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyProductionMonitorTuning,
  controlWorkflow,
  createManagedJob,
  decideWorkflowGate,
  draftProductionFix,
  fetchProductionEngineer,
  fetchSoftwareFactory,
  fixAutomationMessage,
  type ProductionEngineerDashboard,
  recordProductionInvestigation,
  rejectProductionMonitorTuning,
  runFactoryBenchmark,
  tuneProductionMonitor,
  tuningProposalFrom,
  updateProductionIssueStatus,
} from "@/lib/production-engineer/queries";
import { workflowStreamRunIds } from "@/lib/production-engineer/workflow-streams";

export const Route = createFileRoute("/_authed/admin/production-engineer")({
  component: ProductionEngineerPage,
});

function ProductionEngineerPage() {
  const [investigationIssueId, setInvestigationIssueId] = useState("");
  const [investigationSummary, setInvestigationSummary] = useState("");
  const [investigationOutcome, setInvestigationOutcome] = useState("");
  const [investigationApproved, setInvestigationApproved] = useState(false);
  const [workflowSteering, setWorkflowSteering] = useState("");
  const [gateFeedback, setGateFeedback] = useState<Record<string, string>>({});
  const [gateProducer, setGateProducer] = useState<Record<string, string>>({});
  const [streamState, setStreamState] = useState("connecting");
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [steeringMode, setSteeringMode] = useState<string | null>(null);
  const [jobObjective, setJobObjective] = useState("");
  const [jobContextKeys, setJobContextKeys] = useState("");
  const [jobObservablePath, setJobObservablePath] = useState("");
  const [jobExpectedContent, setJobExpectedContent] = useState("");
  const [jobMaximumAttempts, setJobMaximumAttempts] = useState(3);
  const [jobKind, setJobKind] = useState<
    "pull-request-review" | "ci-repair" | "bug-triage" | "visual-delivery"
  >("pull-request-review");
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["production-engineer"],
    queryFn: fetchProductionEngineer,
    // Draft fixes are accepted background jobs. Polling this small admin projection makes the
    // durable issue row—not an HTTP socket—the source of truth for running and terminal state.
    refetchInterval: 2_000,
  });
  const factory = useQuery({
    queryKey: ["software-factory"],
    queryFn: fetchSoftwareFactory,
  });
  const liveRuns = workflowStreamRunIds(factory.data?.workflows ?? []);
  const liveRunKey = liveRuns.join(",");
  useEffect(() => {
    const runIds = liveRunKey ? liveRunKey.split(",") : [];
    if (runIds.length === 0) {
      setStreamState("idle");
      return;
    }
    const refreshFromPush = () =>
      void queryClient.invalidateQueries({ queryKey: ["software-factory"] });
    const appendOutput = (message: Event) => {
      const event = JSON.parse((message as MessageEvent).data) as {
        payload?: { chunk?: string };
      };
      if (!event.payload?.chunk) return;
      setStreamLines((current) =>
        [...current, event.payload?.chunk ?? ""]
          .join("")
          .slice(-65_536)
          .split("\n"),
      );
    };
    const streams = runIds.map((runId) => {
      const events = new EventSource(
        `/api/software-factory/workflows/${encodeURIComponent(runId)}/events`,
      );
      events.addEventListener("open", () => setStreamState("live"));
      events.addEventListener("snapshot", () => {
        setStreamState("live");
        refreshFromPush();
      });
      events.addEventListener("transition", refreshFromPush);
      events.addEventListener("check-output", appendOutput);
      events.addEventListener("executor-output", appendOutput);
      events.addEventListener("control", (message) => {
        const event = JSON.parse((message as MessageEvent).data) as {
          payload?: { mode?: string };
        };
        setSteeringMode(event.payload?.mode ?? "applied");
        refreshFromPush();
      });
      events.addEventListener("error", () => setStreamState("reconnecting"));
      return events;
    });
    return () =>
      streams.forEach((events) => {
        events.close();
      });
  }, [liveRunKey, queryClient]);
  const workflowControl = useMutation({
    mutationFn: controlWorkflow,
    onSuccess: () => {
      setWorkflowSteering("");
      return queryClient.invalidateQueries({ queryKey: ["software-factory"] });
    },
  });
  const gateControl = useMutation({
    mutationFn: decideWorkflowGate,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["software-factory"] }),
  });
  const createJob = useMutation({
    mutationFn: createManagedJob,
    onSuccess: () => {
      setJobObjective("");
      setJobContextKeys("");
      setJobObservablePath("");
      setJobExpectedContent("");
      return queryClient.invalidateQueries({ queryKey: ["software-factory"] });
    },
  });
  const runBenchmark = useMutation({
    mutationFn: () => runFactoryBenchmark(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["software-factory"] }),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["production-engineer"] });
  const tune = useMutation({
    mutationFn: tuneProductionMonitor,
    onSuccess: refresh,
  });
  const applyTuning = useMutation({
    mutationFn: applyProductionMonitorTuning,
    onSuccess: refresh,
  });
  const rejectTuning = useMutation({
    mutationFn: rejectProductionMonitorTuning,
    onSuccess: refresh,
  });
  const fix = useMutation({
    mutationFn: draftProductionFix,
    onSuccess: refresh,
  });
  const investigation = useMutation({
    mutationFn: recordProductionInvestigation,
    onSuccess: () => {
      setInvestigationSummary("");
      setInvestigationOutcome("");
      setInvestigationApproved(false);
      return refresh();
    },
  });
  const issueStatus = useMutation({
    mutationFn: updateProductionIssueStatus,
    onSuccess: refresh,
  });
  const selectedInvestigationIssue =
    investigationIssueId || dashboard.data?.issues[0]?.id || "";
  return (
    <PageShell
      action={
        <Button
          render={<a href="/api/production-engineer/prometheus-rules" />}
          size="sm"
          variant="outline"
        >
          Export Prometheus rules
        </Button>
      }
      description="Persistent monitors, correlated alert triage, tuning proposals, reviewed on-call learning, and fix pull requests. Admin-only; fixes never target main directly."
      title="Production Engineer"
      width="wide"
    >
      <PageSection title="Software factory">
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          data-testid="build-provenance"
        >
          <p className="font-medium">Running build provenance</p>
          <p className="font-mono text-xs text-muted-foreground">
            {factory.data?.provenance
              ? `${factory.data.provenance.branch} @ ${factory.data.provenance.revision} · ${factory.data.provenance.dirty ? "DIRTY" : "CLEAN"}`
              : "Unavailable"}
          </p>
          {factory.data?.provenance?.workerId ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              Worker {factory.data.provenance.workerId}
            </p>
          ) : null}
          <p
            className="text-muted-foreground text-sm"
            data-testid="worktree-usage"
          >
            Active worktrees {factory.data?.worktrees.active ?? 0} · disk{" "}
            {Math.ceil((factory.data?.worktrees.diskBytes ?? 0) / 1024 / 1024)}{" "}
            MiB
          </p>
        </div>
        <p className="mb-3 text-muted-foreground text-sm">
          {(factory.data?.benchmarks ?? []).some(
            (benchmark) => benchmark.source === "measured",
          )
            ? "Measured benchmark routes use executed checks, a judging orchestrator, bounded workers, and tenant-isolated graph context."
            : "Only seeded bootstrap routes exist. They are excluded from routing unless the explicit seeded-route override is enabled."}
        </p>
        {steeringMode ? (
          <p className="mb-2 text-xs" data-testid="steering-mode">
            Latest steering mode: {steeringMode}
          </p>
        ) : null}
        {streamLines.length ? (
          <pre
            className="mb-2 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs"
            data-testid="workflow-live-output"
          >
            {streamLines.slice(-80).join("\n")}
          </pre>
        ) : null}
        <div className="grid gap-3 md:grid-cols-3">
          <FactoryCard
            label="Execution tiers"
            value={factory.data?.executionTiers.join(" → ") ?? "Loading…"}
          />
          <FactoryCard
            label="Managed jobs"
            value={factory.data?.managedJobKinds.join(", ") ?? "Loading…"}
          />
          <FactoryCard
            label="Context graph"
            value={
              factory.data
                ? `${factory.data.contextGraph.nodes} nodes · ${factory.data.contextGraph.edges} edges · ${factory.data.contextGraph.sourceSystems} systems`
                : "Loading…"
            }
          />
          <FactoryCard
            label={
              (factory.data?.benchmarks ?? []).some(
                (benchmark) => benchmark.source === "measured",
              )
                ? "Measured routes"
                : "Seeded routes"
            }
            value={`${factory.data?.benchmarks.length ?? 0} model/job configurations`}
          />
          <FactoryCard
            label="Managed executions"
            value={`${factory.data?.jobs.length ?? 0} durable jobs`}
          />
          <FactoryCard
            label="Webhook reconciler"
            value={
              factory.data?.webhooks
                ? `${factory.data.webhooks.pending} pending · ${factory.data.webhooks.processed} processed · ${factory.data.webhooks.dead} dead-letter`
                : "Unavailable"
            }
          />
          <FactoryCard
            label="Shadow traffic"
            value={
              factory.data?.shadowTraffic
                ? `${factory.data.shadowTraffic.completed} comparisons · ${(factory.data.shadowTraffic.averageAgreement / 100).toFixed(1)}% agreement · ${factory.data.shadowTraffic.averageLatencyMs} ms`
                : "Unavailable"
            }
          />
          <FactoryCard
            label="Evaluator budget"
            value={
              dashboard.data?.runtimeBudgets
                ? `${dashboard.data.runtimeBudgets.evaluatorInflight}/${dashboard.data.runtimeBudgets.evaluatorConcurrency} in flight`
                : "Loading…"
            }
          />
          <FactoryCard
            label="Shadow process budget"
            value={
              dashboard.data?.runtimeBudgets
                ? `${dashboard.data.runtimeBudgets.shadowInflight}/${dashboard.data.runtimeBudgets.shadowConcurrency} in flight · queue ${dashboard.data.runtimeBudgets.shadowQueueCapacity} · ${dashboard.data.runtimeBudgets.shadowDropped} dropped`
                : "Loading…"
            }
          />
        </div>
        <div className="mt-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">Executed model benchmarks</h3>
              <p className="text-muted-foreground text-xs">
                Fixed revision, real harnesses, five deterministic outcomes per
                pair. Quality cannot be submitted by this page.
              </p>
            </div>
            <Button
              disabled={runBenchmark.isPending}
              onClick={() => runBenchmark.mutate()}
              variant="outline"
            >
              Run Codex vs Claude benchmark
            </Button>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Harness/model</th>
                  <th>Task</th>
                  <th>Checks</th>
                  <th>Quality</th>
                  <th>Cost/outcome</th>
                </tr>
              </thead>
              <tbody>
                {(factory.data?.benchmarks ?? []).map((benchmark) => (
                  <tr
                    key={`${benchmark.harness}:${benchmark.model}:${benchmark.task}`}
                  >
                    <td>{benchmark.source}</td>
                    <td>
                      {benchmark.harness}/{benchmark.model}
                    </td>
                    <td>{benchmark.task}</td>
                    <td>
                      {benchmark.successfulOutcomes}/
                      {benchmark.attemptedOutcomes}
                    </td>
                    <td>{Math.round(benchmark.quality * 100)}%</td>
                    <td>
                      {benchmark.successfulOutcomes
                        ? `${Math.round(benchmark.totalCostMicros / benchmark.successfulOutcomes)} µ$`
                        : "n/a"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </PageSection>
      <PageSection title="Shadow execution evidence">
        <p className="mb-3 text-muted-foreground text-sm">
          Asynchronous comparisons are linked to the real primary run. Output is
          represented by SHA-256 hashes; evaluator failures remain visible and
          cannot replace or delay the primary response.
        </p>
        {(factory.data?.shadowTraffic?.recent.length ?? 0) === 0 ? (
          <PageEmpty>No primary request has been shadowed yet.</PageEmpty>
        ) : (
          <div className="space-y-2">
            {factory.data?.shadowTraffic?.recent.map((comparison) => (
              <div
                className="rounded-md border p-3 text-sm"
                key={comparison.id}
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">
                    {comparison.status} · {comparison.primaryModel} →{" "}
                    {comparison.shadowModel}
                  </span>
                  <span>{comparison.shadowLatencyMs} ms</span>
                </div>
                <dl className="mt-2 grid gap-x-2 text-xs md:grid-cols-[120px_1fr]">
                  <dt>Primary run</dt>
                  <dd className="break-all font-mono">
                    {comparison.requestKey}
                  </dd>
                  <dt>Primary SHA-256</dt>
                  <dd className="break-all font-mono">
                    {comparison.primaryOutputHash}
                  </dd>
                  <dt>Shadow SHA-256</dt>
                  <dd className="break-all font-mono">
                    {comparison.shadowOutputHash}
                  </dd>
                  <dt>Evaluator</dt>
                  <dd>{comparison.evaluatorVersion}</dd>
                  {comparison.error ? (
                    <>
                      <dt>Failure</dt>
                      <dd className="text-destructive">{comparison.error}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ))}
          </div>
        )}
      </PageSection>
      <PageSection title="Launch a managed workflow">
        <p className="mb-3 text-muted-foreground text-sm">
          This creates a durable production run. A measured route is used only
          when executed benchmark evidence exists; otherwise launch fails closed
          unless the seeded-route override is explicit. A fresh reviewer
          validates revision-bound artifacts, and completion waits for human
          approval.
        </p>
        <div className="grid gap-2 md:grid-cols-[220px_1fr_auto]">
          <select
            aria-label="Managed job kind"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={jobKind}
            onChange={(event) =>
              setJobKind(event.target.value as typeof jobKind)
            }
          >
            <option value="pull-request-review">Pull request review</option>
            <option value="ci-repair">CI repair</option>
            <option value="bug-triage">Bug triage</option>
            <option value="visual-delivery">Visual delivery</option>
          </select>
          <Input
            aria-label="Managed workflow objective"
            placeholder="Describe one bounded, verifiable objective"
            value={jobObjective}
            onChange={(event) => setJobObjective(event.target.value)}
          />
          <Input
            aria-label="Trusted context keys"
            className="md:col-start-2"
            placeholder="Trusted context keys (comma-separated, optional)"
            value={jobContextKeys}
            onChange={(event) => setJobContextKeys(event.target.value)}
          />
          <Input
            aria-label="Observable output path"
            className="md:col-start-2"
            placeholder="Observable output path (for example PROOF.md)"
            value={jobObservablePath}
            onChange={(event) => setJobObservablePath(event.target.value)}
          />
          <Input
            aria-label="Expected exact output"
            className="md:col-start-2"
            placeholder="Expected exact file content"
            value={jobExpectedContent}
            onChange={(event) => setJobExpectedContent(event.target.value)}
          />
          <Input
            aria-label="Maximum repair attempts"
            className="md:col-start-2"
            max={10}
            min={1}
            type="number"
            value={jobMaximumAttempts}
            onChange={(event) =>
              setJobMaximumAttempts(
                Math.max(1, Math.min(10, Number(event.target.value) || 1)),
              )
            }
          />
          <Button
            className="md:col-start-3 md:row-start-1"
            disabled={
              !jobObjective.trim() ||
              !jobObservablePath.trim() ||
              createJob.isPending
            }
            onClick={() =>
              createJob.mutate({
                kind: jobKind,
                objective: jobObjective,
                maximumAttempts: jobMaximumAttempts,
                concurrencyLimit: 1,
                requiredContext: jobContextKeys
                  .split(",")
                  .map((key) => key.trim())
                  .filter(Boolean),
                observableChange: {
                  path: jobObservablePath,
                  expectedContent: jobExpectedContent,
                },
              })
            }
          >
            Launch managed run
          </Button>
        </div>
        {createJob.isError ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {createJob.error.message}
          </p>
        ) : null}
      </PageSection>
      <PageSection title="Inspectable workflow runs">
        <p
          className="mb-2 text-muted-foreground text-xs"
          data-testid="workflow-stream-state"
        >
          Durable event stream: {streamState}. Steering is delivered by an
          explicit interrupt and restart at the next model turn.
        </p>
        {(factory.data?.workflows.length ?? 0) === 0 ? (
          <PageEmpty>No durable workflow runs exist yet.</PageEmpty>
        ) : (
          <div className="space-y-3">
            {factory.data?.workflows.map(
              ({ run, stages, artifacts, events, evidence }) => (
                <div className="rounded-md border p-3" key={run.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">Run {run.id.slice(0, 8)}</p>
                      <p className="text-muted-foreground text-sm">
                        {run.status} ·{" "}
                        {
                          stages.filter((stage) => stage.status === "succeeded")
                            .length
                        }
                        /{stages.length} stages · concurrency{" "}
                        {run.concurrencyLimit} · repair cap{" "}
                        {run.maximumAttempts}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {run.status === "running" || run.status === "queued" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            workflowControl.mutate({
                              runId: run.id,
                              action: "pause",
                            })
                          }
                        >
                          Pause
                        </Button>
                      ) : null}
                      {run.status === "paused" || run.status === "pausing" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            workflowControl.mutate({
                              runId: run.id,
                              action: "resume",
                            })
                          }
                        >
                          Resume
                        </Button>
                      ) : null}
                      {run.status === "awaiting_approval" &&
                      evidence.readyForApproval ? (
                        <Button
                          size="sm"
                          onClick={() =>
                            workflowControl.mutate({
                              runId: run.id,
                              action: "approve",
                            })
                          }
                        >
                          Approve
                        </Button>
                      ) : null}
                      {!["succeeded", "failed", "aborted"].includes(
                        run.status,
                      ) ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            workflowControl.mutate({
                              runId: run.id,
                              action: "abort",
                            })
                          }
                        >
                          Abort
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className="mt-3 rounded-md border p-2 text-sm"
                    data-testid={`workflow-evidence-${run.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        Causal evidence integrity:{" "}
                        {evidence.verified
                          ? "VERIFIED"
                          : evidence.readyForApproval
                            ? "READY FOR APPROVAL"
                            : evidence.terminal
                              ? "FAILED"
                              : "PENDING"}
                      </span>
                      <a
                        className="underline"
                        href={`/api/software-factory/workflows/${encodeURIComponent(run.id)}/evidence`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Inspect raw proof bundle
                      </a>
                    </div>
                    <ul className="mt-1 grid gap-x-3 text-xs md:grid-cols-2">
                      {Object.entries(evidence.checks)
                        .filter(
                          ([check, passed]) =>
                            check !== "humanApproval" || passed,
                        )
                        .map(([check, passed]) => (
                          <li key={check}>
                            {passed ? "✓" : "✗"} {check}
                          </li>
                        ))}
                      {evidence.readyForApproval ? (
                        <li>○ human approval pending</li>
                      ) : null}
                    </ul>
                  </div>
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer font-medium">
                      Durable transition timeline ({events.length})
                    </summary>
                    <ol className="mt-2 space-y-1 border-l pl-4 text-muted-foreground">
                      {events.map((event) => (
                        <li key={event.id}>
                          {event.entity}
                          {event.stageId ? ` ${event.stageId}` : ""}:{" "}
                          {event.fromStatus ?? "created"}
                          {" → "}
                          {event.toStatus} ·{" "}
                          {new Date(event.createdAt).toLocaleString()}
                        </li>
                      ))}
                    </ol>
                  </details>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {stages.map((stage) => (
                      <div
                        className="rounded-md bg-muted p-2 text-sm"
                        key={stage.stageId}
                      >
                        {stage.checks?.gate ? (
                          <div
                            className="mb-2 rounded border border-amber-500/40 p-2"
                            data-testid={`stage-gate-${run.id}-${stage.stageId}`}
                          >
                            <p className="font-medium">
                              Human gate: {stage.checks.gate.prompt}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Status: {stage.checks.gate.status}
                            </p>
                            {stage.status === "awaiting_approval" ? (
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Input
                                  aria-label={`Gate feedback for ${stage.stageId}`}
                                  placeholder="Required feedback when rejecting"
                                  value={
                                    gateFeedback[
                                      `${run.id}:${stage.stageId}`
                                    ] ?? ""
                                  }
                                  onChange={(event) =>
                                    setGateFeedback((current) => ({
                                      ...current,
                                      [`${run.id}:${stage.stageId}`]:
                                        event.target.value,
                                    }))
                                  }
                                />
                                {stage.dependsOn.ids.length > 1 ? (
                                  <select
                                    aria-label={`Producer to repair for ${stage.stageId}`}
                                    className="h-9 rounded-md border bg-background px-3 text-sm"
                                    value={
                                      gateProducer[
                                        `${run.id}:${stage.stageId}`
                                      ] ?? ""
                                    }
                                    onChange={(event) =>
                                      setGateProducer((current) => ({
                                        ...current,
                                        [`${run.id}:${stage.stageId}`]:
                                          event.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">
                                      Select producer to repair
                                    </option>
                                    {stage.dependsOn.ids.map((producer) => (
                                      <option key={producer} value={producer}>
                                        {producer}
                                      </option>
                                    ))}
                                  </select>
                                ) : null}
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    gateControl.mutate({
                                      runId: run.id,
                                      stageId: stage.stageId,
                                      decision: "approve",
                                    })
                                  }
                                >
                                  Approve stage
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={
                                    !gateFeedback[
                                      `${run.id}:${stage.stageId}`
                                    ]?.trim() ||
                                    (stage.dependsOn.ids.length > 1 &&
                                      !gateProducer[
                                        `${run.id}:${stage.stageId}`
                                      ])
                                  }
                                  onClick={() =>
                                    gateControl.mutate({
                                      runId: run.id,
                                      stageId: stage.stageId,
                                      decision: "reject",
                                      producerStageId:
                                        stage.dependsOn.ids.length === 1
                                          ? stage.dependsOn.ids[0]
                                          : gateProducer[
                                              `${run.id}:${stage.stageId}`
                                            ],
                                      feedback:
                                        gateFeedback[
                                          `${run.id}:${stage.stageId}`
                                        ],
                                    })
                                  }
                                >
                                  Reject with feedback
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <span className="font-medium">{stage.stageId}</span> ·{" "}
                        {stage.status} · attempt {stage.attempts}/
                        {run.maximumAttempts}
                        {stage.selectedHarness && stage.selectedModel
                          ? ` · ${stage.selectedHarness}/${stage.selectedModel}`
                          : " · route pending"}
                        <p className="text-muted-foreground">
                          {stage.objective}
                        </p>
                        {stage.lastError ? (
                          <p className="mt-1 text-destructive text-xs">
                            {stage.lastError}
                          </p>
                        ) : null}
                        {stage.sessionId ? (
                          <dl className="mt-2 grid gap-x-2 text-xs md:grid-cols-[80px_1fr]">
                            <dt>Worker</dt>
                            <dd className="break-all font-mono">
                              {stage.sessionId}
                            </dd>
                            <dt>Reviewer</dt>
                            <dd className="break-all font-mono">
                              {stage.reviewerSessionId ?? "pending"}
                            </dd>
                            <dt>Verdict</dt>
                            <dd>{stage.verification?.summary ?? "pending"}</dd>
                          </dl>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {artifacts.length > 0 ? (
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer font-medium">
                        Provenance-bound artifacts ({artifacts.length})
                      </summary>
                      <div className="mt-2 space-y-2">
                        {artifacts.map((artifact) => (
                          <div
                            className="rounded-md border p-2"
                            key={artifact.id}
                          >
                            <p className="font-medium">{artifact.kind}</p>
                            <dl className="grid gap-x-2 text-xs md:grid-cols-[110px_1fr]">
                              <dt>Revision</dt>
                              <dd className="break-all font-mono">
                                {artifact.revision}
                              </dd>
                              <dt>Checksum</dt>
                              <dd className="break-all font-mono">
                                {artifact.checksum}
                              </dd>
                              <dt>Producer</dt>
                              <dd className="break-all font-mono">
                                {artifact.producerSessionId}
                              </dd>
                              <dt>Command</dt>
                              <dd className="font-mono">
                                {artifact.command} (exit {artifact.exitCode})
                              </dd>
                              <dt>Harness route</dt>
                              <dd>
                                {artifact.metadata?.harness &&
                                artifact.metadata?.model
                                  ? `${artifact.metadata.harness}/${artifact.metadata.model}`
                                  : "runtime command"}
                              </dd>
                              <dt>Captured diff</dt>
                              <dd>{artifact.metadata?.diffBytes ?? 0} bytes</dd>
                              {artifact.kind === "runtime-check" ? (
                                <>
                                  <dt>Evidence source</dt>
                                  <dd>{artifact.metadata?.evidenceSource}</dd>
                                  <dt>Check</dt>
                                  <dd>
                                    {artifact.metadata?.checkId} ·{" "}
                                    {artifact.metadata?.durationMs} ms ·{" "}
                                    {artifact.metadata?.required
                                      ? "required"
                                      : "optional"}
                                  </dd>
                                </>
                              ) : null}
                              <dt>Debt gate</dt>
                              <dd>
                                {artifact.metadata?.debt
                                  ? `${artifact.metadata.debt.violations.length === 0 ? "passed" : "rejected"} · ${artifact.metadata.debt.changedPaths.length} changed paths`
                                  : "legacy artifact"}
                              </dd>
                            </dl>
                            {(artifact.metadata?.trustedContext?.length ?? 0) >
                            0 ? (
                              <details className="mt-2 text-xs">
                                <summary className="cursor-pointer">
                                  Trusted context lineage (
                                  {artifact.metadata?.trustedContext?.length})
                                </summary>
                                <ul className="mt-1 space-y-1">
                                  {artifact.metadata?.trustedContext?.map(
                                    (node) => (
                                      <li
                                        className="break-all font-mono"
                                        key={`${artifact.id}-${node.key}`}
                                      >
                                        {node.key} · {node.sourceSystem} ·{" "}
                                        {node.checksum}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </details>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  {![
                    "succeeded",
                    "failed",
                    "aborted",
                    "awaiting_approval",
                  ].includes(run.status) ? (
                    <div className="mt-3 flex gap-2">
                      <Input
                        aria-label={`Steer run ${run.id}`}
                        value={workflowSteering}
                        onChange={(event) =>
                          setWorkflowSteering(event.target.value)
                        }
                        placeholder="Steer this run without stopping it"
                      />
                      <Button
                        disabled={!workflowSteering.trim()}
                        variant="outline"
                        onClick={() =>
                          workflowControl.mutate({
                            runId: run.id,
                            action: "steer",
                            instruction: workflowSteering,
                          })
                        }
                      >
                        Steer
                      </Button>
                    </div>
                  ) : null}
                </div>
              ),
            )}
          </div>
        )}
      </PageSection>

      <PageSection title="Retrievable context capsules">
        {(factory.data?.contextCapsules.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No long run has compacted context yet. Compacted messages are stored
            verbatim before they leave the active model window.
          </p>
        ) : (
          <div className="grid gap-2">
            {factory.data?.contextCapsules.map((capsule) => (
              <a
                className="rounded-md border p-3 text-sm hover:bg-muted/50"
                href={`/api/software-factory/context-capsules/${encodeURIComponent(capsule.id)}`}
                key={capsule.id}
                rel="noreferrer"
                target="_blank"
              >
                <span className="font-medium">{capsule.threadId}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {capsule.checksum.slice(0, 16)}…
                </span>
              </a>
            ))}
          </div>
        )}
      </PageSection>
      <PageSection title="Monitors">
        {(dashboard.data?.monitors.length ?? 0) === 0 ? (
          <PageEmpty>No merged-change monitors exist yet.</PageEmpty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {dashboard.data?.monitors.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                applying={applyTuning.isPending}
                rejecting={rejectTuning.isPending}
                onApply={() => applyTuning.mutate(monitor.id)}
                onReject={() => rejectTuning.mutate(monitor.id)}
                onTune={() => tune.mutate(monitor.id)}
                tuning={tune.isPending}
              />
            ))}
          </div>
        )}
      </PageSection>
      {tune.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {tune.error.message}
        </p>
      ) : null}
      {applyTuning.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {applyTuning.error.message}
        </p>
      ) : null}
      {rejectTuning.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {rejectTuning.error.message}
        </p>
      ) : null}
      <PageSection title="Production issues">
        <p
          className="mb-3 text-muted-foreground text-sm"
          id="fix-automation-status"
          role="status"
        >
          {fixAutomationMessage(dashboard.data?.fixAutomationEnabled === true)}
        </p>
        {fix.isError ? (
          <p className="mb-3 text-destructive text-sm" role="alert">
            {fix.error.message}
          </p>
        ) : null}
        {(dashboard.data?.issues.length ?? 0) === 0 ? (
          <PageEmpty>No genuine firing alerts have opened an issue.</PageEmpty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="px-4 py-2">Issue</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Triage</th>
                  <th className="px-4 py-2">Fix</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.data?.issues.map((issue) => (
                  <tr className="border-border border-t" key={issue.id}>
                    <td className="px-4 py-2 font-medium">{issue.title}</td>
                    <td className="px-4 py-2">{issue.severity}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <span>{issue.status}</span>
                        {issue.status === "open" ? (
                          <>
                            <Button
                              disabled={issueStatus.isPending}
                              onClick={() =>
                                issueStatus.mutate({
                                  issueId: issue.id,
                                  status: "resolved",
                                })
                              }
                              size="sm"
                              variant="ghost"
                            >
                              Resolve
                            </Button>
                            <Button
                              disabled={issueStatus.isPending}
                              onClick={() =>
                                issueStatus.mutate({
                                  issueId: issue.id,
                                  status: "dismissed",
                                })
                              }
                              size="sm"
                              variant="ghost"
                            >
                              Dismiss
                            </Button>
                          </>
                        ) : (
                          <Button
                            disabled={issueStatus.isPending}
                            onClick={() =>
                              issueStatus.mutate({
                                issueId: issue.id,
                                status: "open",
                              })
                            }
                            size="sm"
                            variant="ghost"
                          >
                            Reopen
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="max-w-xl px-4 py-2">{issue.rootCause}</td>
                    <td className="px-4 py-2">
                      {issue.pullRequestUrl ? (
                        <a className="underline" href={issue.pullRequestUrl}>
                          Open PR
                        </a>
                      ) : issue.fixStatus === "none" ||
                        issue.fixStatus === "failed" ? (
                        <Button
                          aria-describedby="fix-automation-status"
                          disabled={
                            !dashboard.data?.fixAutomationEnabled ||
                            fix.isPending
                          }
                          onClick={() => fix.mutate(issue.id)}
                          size="sm"
                          variant="outline"
                        >
                          {dashboard.data?.fixAutomationEnabled
                            ? issue.fixStatus === "failed"
                              ? "Retry draft fix"
                              : "Draft fix PR"
                            : "Fix automation off"}
                        </Button>
                      ) : issue.fixStatus === "review_required" ? (
                        <a className="underline" href="/admin/analytics">
                          Debt review required
                        </a>
                      ) : issue.fixStatus === "running" ? (
                        "Drafting…"
                      ) : (
                        issue.fixStatus
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
      <PageSection title="Reviewed on-call learning">
        <p className="text-muted-foreground text-sm">
          {dashboard.data?.investigations.filter((item) => item.approved)
            .length ?? 0}{" "}
          approved investigations are eligible for future triage context.
          Unreviewed notes are never learned.
        </p>
        {(dashboard.data?.issues.length ?? 0) > 0 ? (
          <div className="mt-4 grid max-w-3xl gap-3 rounded-lg border border-border bg-card p-4">
            <label className="grid gap-1 text-sm">
              Production issue
              <select
                className="h-9 rounded-md border border-input bg-background px-3"
                onChange={(event) =>
                  setInvestigationIssueId(event.target.value)
                }
                value={selectedInvestigationIssue}
              >
                {dashboard.data?.issues.map((issue) => (
                  <option key={issue.id} value={issue.id}>
                    {issue.title}
                  </option>
                ))}
              </select>
            </label>
            <Input
              aria-label="Investigation summary"
              onChange={(event) => setInvestigationSummary(event.target.value)}
              placeholder="What caused the alert?"
              value={investigationSummary}
            />
            <Input
              aria-label="Investigation outcome"
              onChange={(event) => setInvestigationOutcome(event.target.value)}
              placeholder="What resolved or disproved it?"
              value={investigationOutcome}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={investigationApproved}
                onChange={(event) =>
                  setInvestigationApproved(event.target.checked)
                }
                type="checkbox"
              />
              Reviewed and approved for future triage context
            </label>
            <Button
              disabled={
                !selectedInvestigationIssue ||
                !investigationSummary.trim() ||
                !investigationOutcome.trim() ||
                investigation.isPending
              }
              onClick={() =>
                investigation.mutate({
                  issueId: selectedInvestigationIssue,
                  summary: investigationSummary.trim(),
                  outcome: investigationOutcome.trim(),
                  approved: investigationApproved,
                })
              }
              size="sm"
            >
              Save investigation
            </Button>
            {investigation.isError ? (
              <p className="text-destructive text-sm" role="alert">
                {investigation.error.message}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 grid gap-2">
          {dashboard.data?.investigations.map((item) => (
            <div
              className="rounded-md border border-border p-3 text-sm"
              key={item.id}
            >
              <div className="font-medium">{item.summary}</div>
              <div className="text-muted-foreground">{item.outcome}</div>
              <div className="mt-1 text-muted-foreground text-xs uppercase">
                {item.approved ? "Approved learning" : "Unreviewed note"}
              </div>
            </div>
          ))}
        </div>
      </PageSection>
    </PageShell>
  );
}

function FactoryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="font-medium text-sm">{label}</p>
      <p className="mt-1 text-muted-foreground text-sm">{value}</p>
    </div>
  );
}

function MonitorCard({
  monitor,
  tuning,
  applying,
  rejecting,
  onTune,
  onApply,
  onReject,
}: {
  monitor: NonNullable<ProductionEngineerDashboard["monitors"]>[number];
  tuning: boolean;
  applying: boolean;
  rejecting: boolean;
  onTune: () => void;
  onApply: () => void;
  onReject: () => void;
}) {
  const proposal = tuningProposalFrom(monitor.tuningProposal);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="font-medium">{monitor.title}</div>
      <div className="text-muted-foreground text-sm">
        {monitor.key} · baseline {monitor.baseline ?? "pending"} · threshold{" "}
        {monitor.threshold} · {monitor.firingCount} firings ·{" "}
        {monitor.falsePositiveCount} noise
      </div>
      {proposal ? (
        <div
          className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm"
          role="status"
        >
          <div className="font-medium">
            Proposed threshold: {proposal.proposedThreshold}
          </div>
          <div className="text-muted-foreground">{proposal.reason}</div>
          <div className="mt-1 text-muted-foreground text-xs uppercase">
            {proposal.requiresApproval
              ? "Administrator approval required"
              : "No threshold change recommended"}
          </div>
        </div>
      ) : null}
      <Button
        className="mt-2"
        disabled={tuning}
        onClick={onTune}
        size="sm"
        variant="outline"
      >
        {proposal ? "Re-evaluate tuning" : "Propose tuning"}
      </Button>
      {proposal?.requiresApproval ? (
        <>
          <Button
            className="mt-2 ml-2"
            disabled={applying || rejecting}
            onClick={onApply}
            size="sm"
          >
            Apply proposed threshold
          </Button>
          <Button
            className="mt-2 ml-2"
            disabled={applying || rejecting}
            onClick={onReject}
            size="sm"
            variant="ghost"
          >
            Reject proposal
          </Button>
        </>
      ) : null}
    </div>
  );
}
